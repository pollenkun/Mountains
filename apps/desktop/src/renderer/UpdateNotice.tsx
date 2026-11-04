import { useEffect, useState } from "react";
import type { UpdateState } from "../update-types.ts";
import { useI18n } from "./i18n.tsx";
export function UpdateNotice({ ask, onShow }: { ask: (request: { type: string }) => Promise<unknown>; onShow: () => void }) {
	const [status, setStatus] = useState<UpdateState | null>(null);
	const { lang } = useI18n(); const en = lang === "en";
	useEffect(() => {
		let live = true;
		void ask({ type: "updateState" }).then(state => { if (live && state) setStatus(state as UpdateState); }).catch(() => {});
		const bridge = (window as unknown as { mountains: { onUpdate?: (callback: (state: UpdateState) => void) => () => void } }).mountains;
		const off = bridge.onUpdate?.(setStatus);
		return () => { live = false; off?.(); };
	}, [ask]);
	if (!status || status.busy || (status.phase !== "available" && status.phase !== "ready")) return null;
	return <div className="update-notice" role="status"><span>{status.phase === "ready" ? (en ? `${status.version} downloaded` : `${status.version} 已下载`) : (en ? `${status.version} is available` : `${status.version} 可更新`)}</span><button type="button" className="link" onClick={onShow}>{en ? "View update" : "查看更新"}</button></div>;
}
