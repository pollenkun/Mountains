/**
 * One reply, drawn as Markdown and SIUI components in the order written. The reply's words share one beat;
 * a reply that is already complete when it mounts (a reopened conversation) is shown at once.
 */
import { useEffect, useRef, useState } from "react";
import { ClockGate, newClock, SETTLE_MS, type RevealClock } from "../Motion.tsx";
import { Markdown } from "./markdown.tsx";
import { parse, type UiNode } from "./parse.ts";
import { UiGroup, UiScope } from "./ui.tsx";

export function Reply({ text, live }: { text: string; live: boolean }) {
	const clock = useRef<RevealClock | null>(null);
	clock.current ??= newClock(!live);
	// The stream can end long before the words have landed; what follows a reply waits for them (styles.css).
	const [landed, setLanded] = useState(!live);
	useEffect(() => {
		if (live) { setLanded(false); return; }
		const wait = clock.current!.last + SETTLE_MS - performance.now();
		if (wait <= 0) { setLanded(true); return; }
		const timer = setTimeout(() => setLanded(true), wait);
		return () => clearTimeout(timer);
	}, [live]);
	const blocks = parse(text, live);
	const nodes = blocks.flatMap((b) => b.kind === "ui" ? [b.node] : []) as UiNode[];
	// Components that follow one another are one group; the Markdown between them separates groups.
	const parts: ({ kind: "md"; text: string; offset: number } | { kind: "ui"; nodes: UiNode[]; end: number })[] = [];
	for (const [index, block] of blocks.entries()) {
		const end = (blocks[index + 1] as { offset?: number; node?: UiNode } | undefined)?.offset ?? (blocks[index + 1] as { node?: UiNode } | undefined)?.node?.offset ?? text.length;
		const last = parts[parts.length - 1];
		if (block.kind === "md") parts.push(block);
		else if (last?.kind === "ui") { last.nodes.push(block.node); last.end = end; }
		else parts.push({ kind: "ui", nodes: [block.node], end });
	}
	// A tag still arriving, before there is a component to hold its place.
	const tagging = live && parts[parts.length - 1]?.kind !== "ui" && /(^|\n)\s*(<[^>\n]*|::[^\n]*)$/.test(text);
	const working = (at: number, key: string) => (
		<ClockGate key={key} as="span" clock={clock.current!} at={at} reserve advance>
			<span className="ui-working verb shimmer">正在处理</span>
		</ClockGate>
	);
	return (
		<UiScope nodes={nodes}>
			{parts.map((part, index) => {
				if (part.kind === "md") {
					return <Markdown key={`md${part.offset}`} text={part.text} offset={part.offset} clock={clock.current!} live={live && index === parts.length - 1} />;
				}
				// A component comes in whole: in its turn it says 正在处理 if the model is still writing it, and pops up once it is done.
				const at = part.nodes[0]!.offset;
				if (live && index === parts.length - 1) return working(at, `ui${at}-working`);
				return (
					<ClockGate key={`ui${at}`} as="div" className="ui-pop" clock={clock.current!} at={at} reserve advance>
						<UiGroup nodes={part.nodes} source={text.slice(at, part.end).trim()} live={live} />
					</ClockGate>
				);
			})}
			{tagging ? working(text.lastIndexOf("\n") + 1, "ui-tag") : null}
			{landed ? null : <i className="reply-flying" hidden />}
		</UiScope>
	);
}
