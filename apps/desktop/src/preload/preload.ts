import { contextBridge, ipcRenderer, webUtils } from "electron";

const COMMAND = "mountains:command";
const EVENT = "mountains:event";
const SHELL = "mountains:shell";
const OPEN = "mountains:open";

contextBridge.exposeInMainWorld("mountains", {
	send(command: unknown): void {
		ipcRenderer.send(COMMAND, command);
	},
	shell(request: unknown): Promise<unknown> {
		return ipcRenderer.invoke(SHELL, request);
	},
	/** Where a file dropped on the page lives; empty for one that is not on disk. */
	pathForFile(file: File): string {
		return webUtils.getPathForFile(file);
	},
	onOpen(listener: (conversation: unknown) => void): void {
		ipcRenderer.on(OPEN, (_event, conversation: unknown) => {
			listener(conversation);
		});
	},
	onEvent(listener: (event: unknown) => void): void {
		ipcRenderer.on(EVENT, (_event, payload: unknown) => {
			listener(payload);
		});
	},
	onUpdate(listener: (state: unknown) => void): () => void {
		const handler = (_event: unknown, state: unknown) => listener(state);
		ipcRenderer.on("mountains:updates", handler);
		return () => { ipcRenderer.removeListener("mountains:updates", handler); };
	},
	onAsk(listener: (question: unknown) => void): void {
		ipcRenderer.on("mountains:ask", (_event, question: unknown) => listener(question));
	},
});
