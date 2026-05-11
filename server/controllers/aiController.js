import sql from "./../configs/db.js";
import { clerkClient } from "@clerk/express";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import pdf from "pdf-parse/lib/pdf-parse.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import FormData from "form-data";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const GEMINI_MODEL_CANDIDATES = [
  process.env.GEMINI_TEXT_MODEL,
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
  "gemini-pro-latest",
  "gemma-3-1b-it",
  "gemma-3-4b-it",
].filter(Boolean);

const normalizeGeminiModelName = (name) =>
  name.startsWith("models/") ? name.replace("models/", "") : name;

const shouldTryNextModel = (error) => {
  const status = error?.status || error?.response?.status;
  const message = (error?.message || "").toLowerCase();

  return (
    status === 404 ||
    status === 429 ||
    message.includes("not found") ||
    message.includes("not supported for generatecontent") ||
    message.includes("quota exceeded") ||
    message.includes("too many requests")
  );
};

const generateGeminiText = async (promptText) => {
  let lastError;

  for (const candidate of GEMINI_MODEL_CANDIDATES) {
    const modelName = normalizeGeminiModelName(candidate);

    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(promptText);
      return result.response.text();
    } catch (error) {
      if (shouldTryNextModel(error)) {
        console.warn(`Model failed: ${modelName}. Trying next model.`);
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  throw (
    lastError ||
    new Error(
      "No supported text model available. Set GEMINI_TEXT_MODEL to a valid model from ListModels."
    )
  );
};

const parseErrorBody = (rawBody) => {
  if (!rawBody) return "";

  if (Buffer.isBuffer(rawBody)) {
    const text = rawBody.toString("utf8").trim();
    if (!text) return "";

    try {
      const parsed = JSON.parse(text);
      return parsed?.error || parsed?.message || text;
    } catch {
      return text;
    }
  }

  if (typeof rawBody === "object") {
    return rawBody?.error || rawBody?.message || JSON.stringify(rawBody);
  }

  return String(rawBody);
};

const getErrorMessage = (error, fallback) => {
  const bodyMessage = parseErrorBody(error?.response?.data);
  return bodyMessage || error?.message || fallback;
};

const sendApiError = (res, error, fallback) => {
  const status = error?.response?.status || error?.status || 500;
  const upstreamMessage = getErrorMessage(error, fallback);
  const message =
    status === 429
      ? "AI provider rate limit reached. Please retry in 1-2 minutes."
      : upstreamMessage;

  return res.status(status).json({ success: false, message });
};

const uploadImageBuffer = async (imageBuffer) => {
  const buffer = Buffer.isBuffer(imageBuffer)
    ? imageBuffer
    : Buffer.from(imageBuffer);
  const base64Image = buffer.toString("base64");
  return cloudinary.uploader.upload(`data:image/png;base64,${base64Image}`);
};

export const generateArticle = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt, length } = req.body;
    const plan = req.plan;
    const free_usage = req.free_usage;

    if (plan !== "premium" && free_usage >= 10) {
      return res.json({
        success: false,
        message: "Limit reached. Upgrade to continue.",
      });
    }

    const content = await generateGeminiText(
      `${prompt}. Write an article of ${length} words.`
    );

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${prompt}, ${content}, 'article')
    `;

    if (plan !== "premium") {
      await clerkClient.users.updateUserMetadata(userId, {
        privateMetadata: { free_usage: free_usage + 1 },
      });
    }

    res.json({ success: true, content });
  } catch (error) {
    console.error("Article Error:", error);
    return sendApiError(res, error, "Article generation failed.");
  }
};

export const generateBlogTitle = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt } = req.body;

    const content = await generateGeminiText(
      `Generate 5 catchy blog titles for: ${prompt}`
    );

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${prompt}, ${content}, 'blog-title')
    `;

    res.json({ success: true, content });
  } catch (error) {
    console.error("Title Error:", error);
    return sendApiError(res, error, "Blog title generation failed.");
  }
};

export const generateImage = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { prompt, publish } = req.body;

    if (!prompt) {
      return res.status(400).json({
        success: false,
        message: "Prompt is required.",
      });
    }

    let imageBuffer;

    const generateFromPollinations = async () => {
      const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
        prompt
      )}`;

      const pollinationsResponse = await axios.get(pollinationsUrl, {
        responseType: "arraybuffer",
        timeout: 90000,
      });

      return pollinationsResponse.data;
    };

    const generateFromClipdrop = async () => {
      const clipdropResponse = await axios.post(
        "https://clipdrop-api.co/text-to-image/v1",
        { prompt },
        {
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.CLIPDROP_API_KEY,
          },
          responseType: "arraybuffer",
          timeout: 90000,
        }
      );

      return clipdropResponse.data;
    };

    if (!process.env.HF_API_KEY && process.env.CLIPDROP_API_KEY) {
      try {
        imageBuffer = await generateFromClipdrop();
      } catch {
        imageBuffer = await generateFromPollinations();
      }
    } else if (!process.env.HF_API_KEY) {
      imageBuffer = await generateFromPollinations();
    } else {
      const hfResponse = await axios.post(
        "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2",
        { inputs: prompt },
        {
          headers: {
            Authorization: `Bearer ${process.env.HF_API_KEY}`,
          },
          responseType: "arraybuffer",
          timeout: 90000,
          validateStatus: () => true,
        }
      );

      const hfContentType = hfResponse.headers?.["content-type"] || "";
      const hfReturnedImage = hfContentType.includes("image/");

      if (hfReturnedImage) {
        imageBuffer = hfResponse.data;
      } else if (hfResponse.status === 429 && process.env.CLIPDROP_API_KEY) {
        try {
          imageBuffer = await generateFromClipdrop();
        } catch {
          imageBuffer = await generateFromPollinations();
        }
      } else if (hfResponse.status === 429) {
        imageBuffer = await generateFromPollinations();
      } else {
        const hfError = new Error("Image generation failed from Hugging Face.");
        hfError.response = {
          status: hfResponse.status,
          data: hfResponse.data,
        };
        throw hfError;
      }
    }

    const upload = await uploadImageBuffer(imageBuffer);

    await sql`
      INSERT INTO creations (user_id, prompt, content, type, publish)
      VALUES (${userId}, ${prompt}, ${upload.secure_url}, 'image', ${Boolean(publish)})
    `;

    res.json({ success: true, content: upload.secure_url });
  } catch (error) {
    console.error("Image Error:", error);
    return sendApiError(res, error, "Image generation failed.");
  }
};

export const removeImageBackground = async (req, res) => {
  try {
    const { userId } = req.auth();
    const image = req.file;

    if (!image) {
      return res.json({ success: false, message: "No image uploaded" });
    }

    const upload = await cloudinary.uploader.upload(image.path, {
      transformation: [{ effect: "background_removal" }],
    });

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, 'Background removed', ${upload.secure_url}, 'image')
    `;

    res.json({ success: true, content: upload.secure_url });
  } catch (error) {
    console.error("Remove BG Error:", error);
    return sendApiError(res, error, "Background removal failed.");
  }
};

export const removeImageObject = async (req, res) => {
  try {
    const { userId } = req.auth();
    const { object } = req.body;
    const image = req.file;

    const { public_id } = await cloudinary.uploader.upload(image.path);

    const imageUrl = cloudinary.url(public_id, {
      transformation: [{ effect: `gen_remove:${object}` }],
    });

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, ${`Removed ${object}`}, ${imageUrl}, 'image')
    `;

    res.json({ success: true, content: imageUrl });
  } catch (error) {
    console.error("Remove Object Error:", error);
    return sendApiError(res, error, "Object removal failed.");
  }
};

export const resumeReview = async (req, res) => {
  try {
    const { userId } = req.auth();
    const file = req.file;

    const buffer = fs.readFileSync(file.path);
    const data = await pdf(buffer);

    const content = await generateGeminiText(`Review this resume:\n${data.text}`);

    await sql`
      INSERT INTO creations (user_id, prompt, content, type)
      VALUES (${userId}, 'Resume Review', ${content}, 'resume-review')
    `;

    res.json({ success: true, content });
  } catch (error) {
    console.error("Resume Error:", error);
    return sendApiError(res, error, "Resume review failed.");
  }
};
