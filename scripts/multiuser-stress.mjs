import assert from "node:assert/strict";
import WebSocket from "ws";

const WS_URL = process.env.WS_URL || "wss://online-board.aghaskdbbb.workers.dev";
const BOARD_ID = process.env.BOARD_ID || "Mo23Z58APZ0yRwkkM6gutm";

function waitForMessage(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMessage = (raw) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const parsed = JSON.parse(text);
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(parsed);
        }
      } catch {
        // ignore unparseable
      }
    };

    ws.on("message", onMessage);
  });
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function createTextElement(id, text, x, y, color = "#1e1e1e") {
  return {
    id,
    type: "text",
    x,
    y,
    width: text.length * 10,
    height: 25,
    angle: 0,
    strokeColor: color,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    isDeleted: false,
    text,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: 18,
    containerId: null,
    originalText: text,
    lineHeight: 1.25,
    updated: Date.now(),
  };
}

function createRectElement(id, label, x, y, width, height, strokeColor, bgColor) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor: bgColor,
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    isDeleted: false,
    updated: Date.now(),
  };
}

function createArrowElement(id, x, y, width, height, strokeColor = "#1e1e1e") {
  return {
    id,
    type: "arrow",
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    isDeleted: false,
    points: [
      [0, 0],
      [width, height],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: "arrow",
    updated: Date.now(),
  };
}

function createLineElement(id, x, y, points, strokeColor = "#2f9e44") {
  return {
    id,
    type: "freedraw",
    x,
    y,
    width: 60,
    height: 40,
    angle: 0,
    strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 3,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 100000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 100000),
    isDeleted: false,
    points,
    pressures: points.map(() => 0.5),
    simulatePressure: true,
    updated: Date.now(),
  };
}

const AGENTS = [
  { id: "agent-01", nick: "Агент 1: Архитектор" },
  { id: "agent-02", nick: "Агент 2: Аналитик" },
  { id: "agent-03", nick: "Агент 3: Бэкенд" },
  { id: "agent-04", nick: "Агент 4: Фронтенд" },
  { id: "agent-05", nick: "Агент 5: QA Тестировщик" },
  { id: "agent-06", nick: "Агент 6: UI Дизайнер" },
  { id: "agent-07", nick: "Агент 7: DevOps" },
  { id: "agent-08", nick: "Агент 8: Студент (Самара)" },
  { id: "agent-09", nick: "Агент 9: Студент (Москва)" },
  { id: "agent-10", nick: "Агент 10: Инспектор" },
];

async function run() {
  console.log(`=======================================================`);
  console.log(`🚀 ЗАПУСК СТРЕСС-ТЕСТИРОВАНИЯ: 10 АКТИВНЫХ АГЕНТОВ ОНЛАЙН`);
  console.log(`🎯 Целевой сервер: ${WS_URL}`);
  console.log(`📋 ID доски: ${BOARD_ID}`);
  console.log(`=======================================================\n`);

  const stateByClient = new Map();

  // 1. Connect all 10 clients concurrently
  console.log(`[Шаг 1] Одновременное подключение 10 агентов к WebSocket...`);
  const connPromises = AGENTS.map(async (agent) => {
    const wsUrl = `${WS_URL}/ws/${BOARD_ID}?nick=${encodeURIComponent(agent.nick)}`;
    const ws = await connectWs(wsUrl);

    stateByClient.set(agent.id, {
      receivedElements: new Map(),
      receivedCursors: 0,
      receivedUpdates: 0,
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        const st = stateByClient.get(agent.id);
        if (msg.type === "scene_update") {
          st.receivedUpdates++;
          for (const el of msg.elements) {
            st.receivedElements.set(el.id, el);
          }
        } else if (msg.type === "cursor") {
          st.receivedCursors++;
        }
      } catch {
        // ignore unparseable
      }
    });

    // Send hello
    const snapPromise = waitForMessage(ws, (m) => m.type === "snapshot");
    ws.send(
      JSON.stringify({
        type: "hello",
        client_id: agent.id,
        nick: agent.nick,
      }),
    );

    const snap = await snapPromise;
    for (const el of snap.elements) {
      stateByClient.get(agent.id).receivedElements.set(el.id, el);
    }

    console.log(
      `  ✓ [${agent.nick}] подключился, снимок содержит ${snap.elements.length} элементов, соратников в комнате: ${snap.collaborators.length}`,
    );
    return { agent, ws, snap };
  });

  const connected = await Promise.all(connPromises);
  console.log(`\n🎉 Все 10 агентов успешно вошли на доску!\n`);

  // 2. Coordinated actions: drawing full architecture diagram
  console.log(`[Шаг 2] Совместное синхронное рисование схемы на доске...`);

  const actions = [
    // Agent 1: Header banner
    async () => {
      const banner = createRectElement("stress-banner", "", 50, 400, 950, 70, "#1971c2", "#e7f5ff");
      const title = createTextElement(
        "stress-title",
        "🧪 СТРЕСС-ТЕСТ: 10 АГЕНТОВ РАБОТАЮТ ОДНОВРЕМЕННО НА ЖИВОЙ ДОСКЕ",
        70,
        420,
        "#1971c2",
      );
      for (const el of [banner, title])
        stateByClient.get(AGENTS[0].id).receivedElements.set(el.id, el);
      connected[0].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [banner, title],
        }),
      );
      console.log(`  🎨 [${AGENTS[0].nick}] нарисовал заголовок стресс-теста.`);
    },

    // Agent 2: Block 1
    async () => {
      const b1 = createRectElement("node-1", "", 70, 520, 180, 80, "#2f9e44", "#ebfbee");
      const t1 = createTextElement("node-1-text", "1. Сбор требований", 85, 550, "#2f9e44");
      for (const el of [b1, t1]) stateByClient.get(AGENTS[1].id).receivedElements.set(el.id, el);
      connected[1].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [b1, t1],
        }),
      );
      console.log(`  🎨 [${AGENTS[1].nick}] добавил блок "1. Сбор требований".`);
    },

    // Agent 3: Arrow 1 -> 2
    async () => {
      const arr = createArrowElement("arr-1-2", 250, 560, 70, 0, "#2f9e44");
      stateByClient.get(AGENTS[2].id).receivedElements.set(arr.id, arr);
      connected[2].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [arr],
        }),
      );
      console.log(`  🎨 [${AGENTS[2].nick}] соединил стрелкой блок 1 и блок 2.`);
    },

    // Agent 4: Block 2
    async () => {
      const b2 = createRectElement("node-2", "", 320, 520, 180, 80, "#f08c00", "#fff4e6");
      const t2 = createTextElement("node-2-text", "2. DO + SQLite", 350, 550, "#f08c00");
      for (const el of [b2, t2]) stateByClient.get(AGENTS[3].id).receivedElements.set(el.id, el);
      connected[3].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [b2, t2],
        }),
      );
      console.log(`  🎨 [${AGENTS[3].nick}] добавил блок "2. DO + SQLite".`);
    },

    // Agent 5: Arrow 2 -> 3
    async () => {
      const arr = createArrowElement("arr-2-3", 500, 560, 70, 0, "#f08c00");
      stateByClient.get(AGENTS[4].id).receivedElements.set(arr.id, arr);
      connected[4].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [arr],
        }),
      );
      console.log(`  🎨 [${AGENTS[4].nick}] соединил стрелкой блок 2 и блок 3.`);
    },

    // Agent 6: Block 3
    async () => {
      const b3 = createRectElement("node-3", "", 570, 520, 180, 80, "#ae3ec9", "#f3f0ff");
      const t3 = createTextElement("node-3-text", "3. WebSocket Hibernation", 580, 550, "#ae3ec9");
      for (const el of [b3, t3]) stateByClient.get(AGENTS[5].id).receivedElements.set(el.id, el);
      connected[5].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [b3, t3],
        }),
      );
      console.log(`  🎨 [${AGENTS[5].nick}] добавил блок "3. WebSocket Hibernation".`);
    },

    // Agent 7: Arrow 3 -> 4
    async () => {
      const arr = createArrowElement("arr-3-4", 750, 560, 70, 0, "#ae3ec9");
      stateByClient.get(AGENTS[6].id).receivedElements.set(arr.id, arr);
      connected[6].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [arr],
        }),
      );
      console.log(`  🎨 [${AGENTS[6].nick}] соединил стрелкой блок 3 и блок 4.`);
    },

    // Agent 8: Block 4
    async () => {
      const b4 = createRectElement("node-4", "", 820, 520, 180, 80, "#e03131", "#fff5f5");
      const t4 = createTextElement("node-4-text", "4. Edge Deployed", 840, 550, "#e03131");
      for (const el of [b4, t4]) stateByClient.get(AGENTS[7].id).receivedElements.set(el.id, el);
      connected[7].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [b4, t4],
        }),
      );
      console.log(`  🎨 [${AGENTS[7].nick}] добавил блок "4. Edge Deployed".`);
    },

    // Agent 9: Drawing checkmark
    async () => {
      const checkPoints = [
        [0, 20],
        [15, 35],
        [45, 5],
      ];
      const checkmark = createLineElement("check-1", 930, 620, checkPoints, "#2f9e44");
      const note = createTextElement("note-ok", "✅ Проверено 10 агентами!", 720, 630, "#2f9e44");
      for (const el of [checkmark, note])
        stateByClient.get(AGENTS[8].id).receivedElements.set(el.id, el);
      connected[8].ws.send(
        JSON.stringify({
          type: "scene_update",
          elements: [checkmark, note],
        }),
      );
      console.log(`  🎨 [${AGENTS[8].nick}] поставил зелёную галочку "Проверено 10 агентами!".`);
    },

    // Agent 10: Moving cursor
    async () => {
      console.log(`  🖱️  [${AGENTS[9].nick}] симулирует активное движение курсора...`);
      for (let x = 100; x <= 900; x += 150) {
        connected[9].ws.send(
          JSON.stringify({
            type: "cursor",
            x,
            y: 560,
            pointer: "down",
            tool: "selection",
          }),
        );
        await new Promise((r) => setTimeout(r, 60));
      }
    },
  ];

  // Execute all actions in parallel / interleaved
  await Promise.all(actions.map((act) => act()));

  console.log(
    `\n⏳ Ожидание взаимного распространения и синхронизации всех элементов (2 секунды)...`,
  );
  await new Promise((r) => setTimeout(r, 2000));

  // 3. Verification across all 10 clients
  console.log(`\n[Шаг 3] Проверка целостности и полноты синхронизации между всеми 10 клиентами:`);
  let allSynced = true;
  const expectedElementIds = [
    "stress-banner",
    "stress-title",
    "node-1",
    "node-1-text",
    "arr-1-2",
    "node-2",
    "node-2-text",
    "arr-2-3",
    "node-3",
    "node-3-text",
    "arr-3-4",
    "node-4",
    "node-4-text",
    "check-1",
    "note-ok",
  ];

  for (let i = 0; i < AGENTS.length; i++) {
    const ag = AGENTS[i];
    const st = stateByClient.get(ag.id);
    const missing = expectedElementIds.filter((id) => !st.receivedElements.has(id));
    if (missing.length > 0) {
      console.error(`  ❌ [${ag.nick}] НЕ получил элементы: ${missing.join(", ")}`);
      allSynced = false;
    } else {
      console.log(
        `  ✅ [${ag.nick}]: получил ВСЕ 15 элементов стресс-теста (всего на доске: ${st.receivedElements.size}, обновлений: ${st.receivedUpdates}, курсоров: ${st.receivedCursors})`,
      );
    }
  }

  assert.ok(allSynced, "Все 10 агентов должны были синхронно получить все нарисованные элементы");

  // 4. Test Persistence: Wait for SAVE_INTERVAL_MS (5s) to flush to SQLite
  console.log(`\n[Шаг 4] Проверка сохранения снимка в базу данных Durable Object (SQLite)...`);
  console.log(
    `  ⏳ Ожидаем 6 секунд для гарантированного срабатывания flushSnapshot (интервал 5 сек)...`,
  );
  await new Promise((r) => setTimeout(r, 6000));

  // 5. Close all 10 clients
  console.log(`\n[Шаг 5] Отключение всех 10 агентов...`);
  for (const c of connected) {
    c.ws.close();
  }
  await new Promise((r) => setTimeout(r, 1000));

  // 6. Connect an 11th client to verify persistence from clean state
  console.log(
    `\n[Шаг 6] Подключение независимого 11-го клиента для проверки восстановления из SQLite...`,
  );
  const verifyWsUrl = `${WS_URL}/ws/${BOARD_ID}?nick=${encodeURIComponent("Проверка_Долговечности")}`;
  const verifyWs = await connectWs(verifyWsUrl);

  const finalSnapPromise = waitForMessage(verifyWs, (m) => m.type === "snapshot");
  verifyWs.send(
    JSON.stringify({
      type: "hello",
      client_id: "verifier-client-11",
      nick: "Проверка_Долговечности",
    }),
  );

  const finalSnap = await finalSnapPromise;
  console.log(`  📊 Получен снимок из SQLite: всего элементов ${finalSnap.elements.length}`);
  for (const id of expectedElementIds) {
    const found = finalSnap.elements.some((el) => el.id === id);
    assert.ok(found, `Элемент ${id} должен быть сохранён в SQLite`);
  }
  console.log(
    `  ✅ ВСЕ 15 элементов стресс-теста успешно прочитаны из постоянного хранилища SQLite!`,
  );
  verifyWs.close();

  console.log(`\n=======================================================`);
  console.log(`🎉 СТРЕСС-ТЕСТ НА 10 ОДНОВРЕМЕННЫХ АГЕНТОВ УСПЕШНО ПРОЙДЕН!`);
  console.log(`   - 10 клиентов одновременно подключились`);
  console.log(`   - 15 векторных фигур/текстов/стрелок/росписей созданы`);
  console.log(`   - 100% широковещательная синхронизация без потерь`);
  console.log(`   - SQLite снимок сохранён и проверен после переподключения`);
  console.log(`=======================================================`);
}

run().catch((err) => {
  console.error("❌ Ошибка выполнения стресс-теста:", err);
  process.exit(1);
});
