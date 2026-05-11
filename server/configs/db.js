// updated

import {neon} from "@neondatabase/serverless";

let sql;

if (process.env.DEV_NO_DB === 'true') {
	const creations = [];

	sql = async (strings, ...values) => {
		const query = strings.join('$');
		if (/SELECT \* FROM creations WHERE id = \$/.test(query) || /SELECT \* FROM creations WHERE id =/.test(query)) {
			const id = values[0];
			const row = creations.find(r => r.id === id);
			return row ? [row] : [];
		}
		if (/SELECT \* FROM creations WHERE publish = true/i.test(query) || /SELECT \* FROM creations ORDER BY/i.test(query)) {
			return creations.filter(r => r.publish);
		}
		if (/SELECT \* FROM creations WHERE user_id =/.test(query)) {
			const userId = values[0];
			return creations.filter(r => r.user_id === userId);
		}
		if (/UPDATE creations SET likes =/.test(query)) {
			return [{ success: true }];
		}
		if (/INSERT INTO creations/i.test(query)) {
			const newRow = { id: (creations.length + 1).toString(), created_at: new Date().toISOString(), ...values[0] };
			creations.unshift(newRow);
			return [newRow];
		}
		return [];
	};
} else {
	sql = neon(`${process.env.DATABASE_URL}`);
}

export default sql;