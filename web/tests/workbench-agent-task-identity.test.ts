import { expect, test } from "bun:test";
import type { useWorkbenchAgentStore } from "../src/stores/use-workbench-agent-store";

async function freshSession(name: string) {
    const module = await import(`../src/stores/use-workbench-agent-store.ts?task-identity-${name}`);
    return module.useWorkbenchAgentStore as typeof useWorkbenchAgentStore;
}

test.each(["image", "video"] as const)("a persisted %s task ID cannot update a new session after module reload", async kind => {
    const first = await freshSession(`${kind}-first`);
    const second = await freshSession(`${kind}-second`);
    const dispatch = kind === "image" ? "dispatchImage" : "dispatchVideo";
    const command = kind === "image" ? "imageCommand" : "videoCommand";
    const previousId = first.getState()[dispatch]({ prompt: "previous session", run: true })!;
    const currentId = second.getState()[dispatch]({ prompt: "current session", run: true })!;
    expect(first.getState()[command]?.nonce).toBe(1);
    expect(second.getState()[command]?.nonce).toBe(1);
    expect(currentId).not.toBe(previousId);
    const current = second.getState().tasks[0];
    second.getState().updateTask(previousId, { status: "succeeded", successCount: 1 });
    expect(second.getState().tasks[0]).toBe(current);
    expect(second.getState().tasks[0].status).toBe("queued");
    second.getState().updateTask(currentId, { status: "running" });
    expect(second.getState().tasks[0].status).toBe("running");
});

test("command consumption keeps its session nonce independent of task identity", async () => {
    const session = await freshSession("commands");
    expect(session.getState().dispatchVideo({ prompt: "draft only", run: false })).toBeUndefined();
    expect(session.getState().videoCommand).toMatchObject({ nonce: 1, run: false, taskId: undefined });
    expect(session.getState().tasks).toEqual([]);
    session.getState().clearVideoCommand();
    const taskId = session.getState().dispatchImage({ prompt: "generate", run: true });
    expect(session.getState().imageCommand).toMatchObject({ nonce: 2, run: true, taskId });
    session.getState().clearImageCommand();
    expect(session.getState().imageCommand).toBeNull();
    expect(session.getState().tasks[0].id).toBe(taskId!);
});
