/**
 * Markdown, drawn as the page's own elements (never as HTML from the reply): headings, paragraphs, lists,
 * quotes, code, tables and rules; inline code, bold, italic, strikethrough, links shown as text, and SIUI's
 * inline style `[words]{green bold}`. Every piece of text rises in on the reply's shared beat.
 */
import { memo, type ReactNode } from "react";
import { AnimatedText, ClockGate, type RevealClock } from "../Motion.tsx";
import { CopyButton } from "../Actions.tsx";
import { parseMath, type MathNode } from "./math.ts";

export const STYLE_CLASSES = new Set(["green", "red", "yellow", "blue", "purple", "muted", "accent", "big", "huge", "giant", "small", "bold", "mono"]);

/** What one call draws with: the shared beat, and whether this is the reply's last, still growing, text. */
interface Pen { clock: RevealClock; live: boolean }

type Inline = { kind: "text"; text: string; at: number } | { kind: "math"; tex: string; at: number } | { kind: "wrap"; tag: "code" | "strong" | "em" | "del" | "link" | "style"; classes?: string[]; title?: string; children: Inline[]; at: number };

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(?<![\p{L}\p{N}_])_([^_\s][^_]*?)_(?![\p{L}\p{N}_])|~~([^~]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|\[([^\]]+)\]\{([^}]+)\}|\\\((.+?)\\\)|(?<![\\$\p{N}])\$(?![\s$])([^$\n]*?[^$\s\\])\$(?![\p{N}$])|<span\s+class(?:Name)?=["']?([^"'>]+)["']?>(.+?)<\/span>/gu;

function inline(text: string, at: number): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		const start = m.index!;
		if (start > last) out.push({ kind: "text", text: text.slice(last, start), at: at + last });
		const inner = at + start + 1;
		if (m[12] !== undefined || m[13] !== undefined) out.push({ kind: "math", tex: m[12] ?? m[13]!, at: at + start });
		else if (m[14] !== undefined) {
			const classes = m[14].split(/\s+/).filter((w) => STYLE_CLASSES.has(w));
			out.push({ kind: "wrap", tag: "style", classes, children: inline(m[15]!, at + start + m[0].indexOf(">") + 1), at: at + start });
		}
		else if (m[2] !== undefined) out.push({ kind: "wrap", tag: "code", children: [{ kind: "text", text: m[2], at: inner }], at: at + start });
		else if (m[3] !== undefined || m[4] !== undefined) out.push({ kind: "wrap", tag: "strong", children: inline(m[3] ?? m[4]!, inner + 1), at: at + start });
		else if (m[5] !== undefined || m[6] !== undefined) out.push({ kind: "wrap", tag: "em", children: inline(m[5] ?? m[6]!, inner), at: at + start });
		else if (m[7] !== undefined) out.push({ kind: "wrap", tag: "del", children: inline(m[7], inner + 1), at: at + start });
		else if (m[8] !== undefined) out.push({ kind: "wrap", tag: "link", title: m[9]!, children: inline(m[8], inner), at: at + start });
		else {
			const classes = m[11]!.split(/[\s,]+/).map((w) => w.replace(/^\./, "")).filter((w) => STYLE_CLASSES.has(w));
			out.push({ kind: "wrap", tag: "style", classes, children: inline(m[10]!, inner), at: at + start });
		}
		last = start + m[0].length;
	}
	if (last < text.length) out.push({ kind: "text", text: text.slice(last), at: at + last });
	return out;
}

/** The last text piece of a run of inlines, which alone may still be growing. */
function lastText(items: Inline[]): Inline | null {
	const tail = items[items.length - 1];
	if (!tail) return null;
	return tail.kind === "wrap" ? lastText(tail.children) ?? tail : tail;
}

function mathNodes(nodes: MathNode[]): ReactNode[] {
	return nodes.map((node, i) => {
		switch (node.kind) {
			case "text": return node.italic ? <i key={i}>{node.text}</i> : node.text;
			case "sub": return <sub key={i}>{mathNodes(node.children)}</sub>;
			case "sup": return <sup key={i}>{mathNodes(node.children)}</sup>;
			case "group": return <span key={i}>{mathNodes(node.children)}</span>;
			case "sqrt": return <span key={i} className="math-sqrt">√<span>{mathNodes(node.children)}</span></span>;
			case "frac": return <span key={i} className="math-frac"><span>{mathNodes(node.over)}</span><span>{mathNodes(node.under)}</span></span>;
		}
	});
}

function Tex({ tex, block }: { tex: string; block?: boolean }) {
	return <span className={block ? "md-math block" : "md-math"} title={tex}>{mathNodes(parseMath(tex))}</span>;
}

function Inlines({ items, pen }: { items: Inline[]; pen: Pen }): ReactNode {
	const growing = pen.live ? lastText(items) : null;
	const draw = (list: Inline[]): ReactNode[] => list.map((item, i) => {
		if (item.kind === "text") return <AnimatedText key={i} text={item.text} live={item === growing} clock={pen.clock} offset={item.at} />;
		if (item.kind === "math") return <ClockGate key={i} as="span" clock={pen.clock} at={item.at} reserve><Tex tex={item.tex} /></ClockGate>;
		const children = draw(item.children);
		switch (item.tag) {
			case "code": return <ClockGate key={i} as="code" clock={pen.clock} at={item.at} live={pen.live}>{children}</ClockGate>;
			case "strong": return <strong key={i}>{children}</strong>;
			case "em": return <em key={i}>{children}</em>;
			case "del": return <del key={i}>{children}</del>;
			// A link is shown, not followed: the reply cannot send the page anywhere.
			case "link": return <span key={i} className="md-link" title={item.title}>{children}</span>;
			default: return <span key={i} className={(item.classes ?? []).map((c) => `ui-${c}`).join(" ")}>{children}</span>;
		}
	});
	return <>{draw(items)}</>;
}

type MdBlock =
	| { kind: "p" | "h"; level?: number; text: string; at: number }
	| { kind: "code"; lang: string; text: string; at: number }
	| { kind: "math"; text: string; at: number }
	| { kind: "quote"; text: string; at: number }
	| { kind: "list"; ordered: boolean; items: { text: string; at: number }[]; at: number }
	| { kind: "table"; head: { text: string; at: number }[]; rows: { text: string; at: number }[][]; at: number }
	| { kind: "hr"; at: number };

function blocks(source: string, base: number): MdBlock[] {
	const lines = source.split("\n");
	const offsets: number[] = [];
	let running = base;
	for (const line of lines) { offsets.push(running); running += line.length + 1; }
	const out: MdBlock[] = [];
	const row = (line: string, at: number) => {
		const cells: { text: string; at: number }[] = [];
		let cursor = line.indexOf("|") === line.search(/\S/) ? line.indexOf("|") + 1 : 0;
		for (const part of line.slice(cursor).replace(/\|\s*$/, "").split("|")) { cells.push({ text: part.trim(), at: at + cursor + part.search(/\S|$/) }); cursor += part.length + 1; }
		return cells;
	};
	for (let i = 0; i < lines.length;) {
		const line = lines[i]!, at = offsets[i]!;
		if (!line.trim()) { i++; continue; }
		const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line);
		if (fence) {
			const body: string[] = [];
			for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
			i++;
			out.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n"), at });
			continue;
		}
		const math = /^\s*(\\\[|\$\$)/.exec(line);
		if (math) {
			const close = math[1] === "$$" ? "$$" : "\\]";
			const body: string[] = [];
			let rest = line.slice(math[0].length);
			for (;;) {
				const end = rest.indexOf(close);
				if (end >= 0) { body.push(rest.slice(0, end)); i++; break; }
				body.push(rest);
				i++;
				if (i >= lines.length) break;
				rest = lines[i]!;
			}
			out.push({ kind: "math", text: body.join("\n").trim(), at });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) { out.push({ kind: "h", level: heading[1]!.length, text: heading[2]!.replace(/\s+#+\s*$/, ""), at: at + heading[1]!.length + 1 }); i++; continue; }
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ kind: "hr", at }); i++; continue; }
		if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
			const head = row(line, at), rows: { text: string; at: number }[][] = [];
			for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!); i++) rows.push(row(lines[i]!, offsets[i]!));
			out.push({ kind: "table", head, rows, at });
			continue;
		}
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ""));
			out.push({ kind: "quote", text: body.join("\n"), at });
			continue;
		}
		const bullet = /^\s*([-*+]|\d+[.)])\s+/;
		if (bullet.test(line)) {
			const ordered = /\d/.test(bullet.exec(line)![1]!);
			const items: { text: string; at: number }[] = [];
			for (; i < lines.length && bullet.test(lines[i]!); i++) {
				const marker = bullet.exec(lines[i]!)![0];
				items.push({ text: lines[i]!.slice(marker.length).replace(/^\[ \]\s+/, "☐ ").replace(/^\[x\]\s+/i, "☑ "), at: offsets[i]! + marker.length });
			}
			out.push({ kind: "list", ordered, items, at });
			continue;
		}
		const para: string[] = [];
		for (; i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\\\[|\s*\$\$|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]!) && !(/^\s*\|.*\|\s*$/.test(lines[i]!) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")); i++) para.push(lines[i]!);
		out.push({ kind: "p", text: para.join("\n"), at });
	}
	return out;
}

/** One block. A block that is finished never changes, so a long stream redraws only the last one. */
const BlockView = memo(function BlockView({ block, clock, live }: { block: MdBlock; source: string; clock: RevealClock; live: boolean }) {
	const pen: Pen = { clock, live };
	const words = (t: string, at: number) => <Inlines items={inline(t, at)} pen={pen} />;
	// Only the very last cell can still be growing; a held word in any other would let later text go first.
	const cell = (t: string, at: number, last: boolean) => <Inlines items={inline(t, at)} pen={{ clock, live: live && last }} />;
	switch (block.kind) {
		case "h": { const Tag = `h${Math.min(6, block.level! + 2)}` as "h3"; return <Tag className="md-h">{words(block.text, block.at)}</Tag>; }
		case "p": return <p className="md-p">{words(block.text, block.at)}</p>;
		case "quote": return <ClockGate as="blockquote" className="md-quote" clock={clock} at={block.at} live={live}><Markdown text={block.text} offset={block.at} clock={clock} live={live} /></ClockGate>;
		case "code": return <ClockGate as="div" className="md-code-wrap" clock={clock} at={block.at} reserve advance><pre className="md-code"><code>{block.text}</code></pre>{live ? null : <CopyButton text={block.text} label="复制代码" className="code-copy" />}</ClockGate>;
		case "math": return <ClockGate as="div" className="md-math-wrap" clock={clock} at={block.at} reserve advance><Tex tex={block.text} block /></ClockGate>;
		case "hr": return <ClockGate as="hr" className="md-hr" clock={clock} at={block.at} reserve advance />;
		case "list": {
			const Tag = block.ordered ? "ol" : "ul";
			return (
				<Tag className="md-list">
					{block.items.map((item, i) => {
						const itemLive = live && i === block.items.length - 1;
						const nextAt = i + 1 < block.items.length ? block.items[i + 1]!.at : undefined;
						return (
							<ClockGate key={i} as="li" clock={clock} at={item.at} {...(nextAt !== undefined ? { end: nextAt } : {})} live={itemLive}>
								<Inlines items={inline(item.text, item.at)} pen={{ clock, live: itemLive }} />
							</ClockGate>
						);
					})}
				</Tag>
			);
		}
		case "table": return (
			<ClockGate as="div" className="md-table-wrap" clock={clock} at={block.at} live={live}><table className="md-table">
				<thead><tr>{block.head.map((head, i) => <th key={i}>{cell(head.text, head.at, !block.rows.length && i === block.head.length - 1)}</th>)}</tr></thead>
				<tbody>{block.rows.map((cells, r) => (
					<ClockGate key={r} as="tr" clock={clock} at={cells[0]?.at ?? block.at} live={live && r === block.rows.length - 1}>
						{cells.map((body, i) => <td key={i}>{cell(body.text, body.at, r === block.rows.length - 1 && i === cells.length - 1)}</td>)}
					</ClockGate>
				))}</tbody>
			</table></ClockGate>
		);
	}
}, (a, b) => a.source === b.source && a.live === b.live && a.block.at === b.block.at && a.clock === b.clock);

/** One Markdown part of a reply. `live` marks the part that is still being written. */
export function Markdown({ text, offset, clock, live }: { text: string; offset: number; clock: RevealClock; live: boolean }) {
	const list = blocks(text, offset);
	return (
		<>
			{list.map((block, index) => (
				<BlockView key={index} block={block} source={text.slice(block.at - offset, index + 1 < list.length ? list[index + 1]!.at - offset : text.length)} clock={clock} live={live && index === list.length - 1} />
			))}
		</>
	);
}
