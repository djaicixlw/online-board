import assert from "node:assert/strict";
import WebSocket from "ws";

const DEFAULT_WS_SMOKE_URL = "ws://localhost:8787";
const BOARD_ID = process.env.WS_SMOKE_BOARD_ID || "SmokeTestBoard12345678";

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolveMsg, rejectMsg) => {
    const timer = setTimeout(() => {
      rejectMsg(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    const onMessage = (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed = JSON.parse(text);
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolveMsg(parsed);
      }
    };

    ws.on("message", onMessage);
  });
}

function connectWs(url) {
  return new Promise((resolveConn, rejectConn) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolveConn(ws));
    ws.once("error", rejectConn);
  });
}

async function main() {
  const baseUrl = (process.env.WS_SMOKE_URL || DEFAULT_WS_SMOKE_URL).replace(/\/$/, "");
  console.log(`[ws-smoke] Подключение к серверу Worker (wrangler dev): ${baseUrl}`);

  const ws1Url = `${baseUrl}/ws/${BOARD_ID}?nick=${encodeURIComponent("Преподаватель")}`;
  const ws2Url = `${baseUrl}/ws/${BOARD_ID}?nick=${encodeURIComponent("Ученик_Анна")}`;

  // 1. Connect Client 1 and Client 2
  const client1 = await connectWs(ws1Url);
  const client2 = await connectWs(ws2Url);

  const snap1Promise = waitForMessage(client1, (m) => m.type === "snapshot");
  client1.send(
    JSON.stringify({
      type: "hello",
      client_id: "smoke-client-1",
      nick: "Преподаватель",
    }),
  );
  const snap1 = await snap1Promise;
  assert.equal(snap1.type, "snapshot");
  console.log(
    `[ws-smoke] Клиент 1 (Преподаватель) получил snapshot (элементов: ${snap1.elements.length}).`,
  );

  const snap2Promise = waitForMessage(client2, (m) => m.type === "snapshot");
  client2.send(
    JSON.stringify({
      type: "hello",
      client_id: "smoke-client-2",
      nick: "Ученик_Анна",
    }),
  );
  const snap2 = await snap2Promise;
  assert.equal(snap2.type, "snapshot");
  console.log(
    `[ws-smoke] Клиент 2 (Ученик_Анна) подключён (активных участников: ${snap2.collaborators.length}).`,
  );

  // 2. Client 1 draws an element -> Client 2 receives scene_update
  const nextVersion = (snap1.elements.find((el) => el.id === "rect-lesson-1")?.version ?? 1) + 1;
  const drawnElement = {
    id: "rect-lesson-1",
    type: "rectangle",
    x: 120,
    y: 80,
    width: 200,
    height: 100,
    version: nextVersion,
    versionNonce: 424242,
    updated: Date.now(),
  };

  const updateOnClient2Promise = waitForMessage(client2, (m) => m.type === "scene_update");
  client1.send(
    JSON.stringify({
      type: "scene_update",
      elements: [drawnElement],
    }),
  );

  const updateOnClient2 = await updateOnClient2Promise;
  assert.equal(updateOnClient2.client_id, "smoke-client-1");
  assert.equal(updateOnClient2.nick, "Преподаватель");
  assert.equal(updateOnClient2.elements.length, 1);
  assert.equal(updateOnClient2.elements[0].id, "rect-lesson-1");
  console.log(
    `[ws-smoke] Клиент 2 получил scene_update от "${updateOnClient2.nick}" (элемент: ${updateOnClient2.elements[0].id}).`,
  );

  // 3. New Client 3 connects and receives snapshot with the drawn element
  const ws3Url = `${baseUrl}/ws/${BOARD_ID}?nick=${encodeURIComponent("Ученик_Иван")}`;
  const client3 = await connectWs(ws3Url);
  const snap3Promise = waitForMessage(client3, (m) => m.type === "snapshot");
  client3.send(
    JSON.stringify({
      type: "hello",
      client_id: "smoke-client-3",
      nick: "Ученик_Иван",
    }),
  );

  const snap3 = await snap3Promise;
  assert.ok(snap3.elements.some((el) => el.id === "rect-lesson-1"));
  assert.equal(snap3.collaborators.length, 3);
  console.log(
    `[ws-smoke] Новый Клиент 3 (Ученик_Иван) получил актуальный snapshot (элементов: ${snap3.elements.length}, участников: ${snap3.collaborators.length}).`,
  );

  // 4. Close all connections cleanly
  client1.close(1000, "done");
  client2.close(1000, "done");
  client3.close(1000, "done");
  await new Promise((r) => setTimeout(r, 100));

  console.log(
    "[ws-smoke] УСПЕШНО: все проверки совместного рисования и получения snapshot на внешнем сервере пройдены.",
  );
}

main().catch((err) => {
  console.error(
    "[ws-smoke] ОШИБКА (убедитесь, что в другом терминале запущен `npm run dev` или задан WS_SMOKE_URL):",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
