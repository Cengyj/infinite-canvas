const readers = new Set<() => unknown>();

const probes = new Map<string, () => void>();
const tabChannel = createTabChannel();

function createTabChannel() {
    if (typeof document === "undefined" || typeof BroadcastChannel === "undefined") return null;
    try {
        const channel = new BroadcastChannel("infinite-canvas:image-storage-tabs");
        channel.addEventListener("message", (event: MessageEvent<{ type?: string; id?: string }>) => {
            const { type, id } = event.data || {};
            if (typeof id !== "string") return;
            if (type === "probe") channel.postMessage({ type: "present", id });
            else if (type === "present") probes.get(id)?.();
        });
        return channel;
    } catch { return null; }
}

// Another tab can own unsaved inputs and undo history invisible to this tab.
export async function shouldDeferMediaCleanup() {
    if (typeof document === "undefined") return false;
    if (!tabChannel) return true;
    return new Promise<boolean>((resolve) => {
        const id = crypto.randomUUID();
        const finish = (present: boolean) => {
            clearTimeout(timer);
            probes.delete(id);
            resolve(present);
        };
        const timer = setTimeout(() => finish(false), 200);
        probes.set(id, () => finish(true));
        try { tabChannel.postMessage({ type: "probe", id }); }
        catch { finish(true); }
    });
}

// Mounted pages also own files through undo history and unsaved workbench inputs.
export function retainMediaReferences(read: () => unknown) {
    readers.add(read);
    return () => { readers.delete(read); };
}

export function readRetainedMediaReferences() {
    return Array.from(readers, (read) => read());
}
