/** Markdown to HTML for pasting into editors: headings, emphasis, code, links, lists, quotes, tables, paragraphs. */
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
	const codes: string[] = [];
	let out = escape(s).replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
	out = out
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
		.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>")
		.replace(/~~([^~]+)~~/g, "<del>$1</del>");
	return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]!);
}

export function markdownToHtml(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;
	const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
	const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) { i++; continue; }
		const fence = /^\s*(```|~~~)/.exec(line);
		if (fence) {
			const body: string[] = [];
			for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
			i++;
			out.push(`<pre><code>${escape(body.join("\n"))}</code></pre>`);
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) { out.push(`<h${heading[1]!.length}>${inline(heading[2]!.replace(/\s+#+\s*$/, ""))}</h${heading[1]!.length}>`); i++; continue; }
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
		if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) {
			const head = cells(line);
			const rows: string[][] = [];
			for (i += 2; i < lines.length && isTableRow(lines[i]!); i++) rows.push(cells(lines[i]!));
			out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
			continue;
		}
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ""));
			out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
			continue;
		}
		const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
		if (list) {
			const ordered = /\d/.test(list[1]!);
			const items: string[] = [];
			for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!); i++) items.push(`<li>${inline(lines[i]!.replace(/^\s*([-*+]|\d+[.)])\s+/, "").replace(/^\[ \]\s+/, "☐ ").replace(/^\[x\]\s+/i, "☑ "))}</li>`);
			out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
			continue;
		}
		const para: string[] = [];
		for (; i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!) && !isTableRow(lines[i]!); i++) para.push(inline(lines[i]!.trim()));
		out.push(`<p>${para.join("<br>")}</p>`);
	}
	return out.join("\n");
}
