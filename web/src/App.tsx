import React, { Suspense, useEffect, useState } from "react";
import { generateBoardId, parseBoardRoute } from "./collab/index.js";
import { RU_STRINGS } from "./i18n/ru.js";

const BoardView = React.lazy(() => import("./board/BoardView.js"));
const TeacherCabinet = React.lazy(() => import("./teacher/TeacherCabinet.js"));

const isDevEnvironment = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [routeState, setRouteState] = useState(() => parseBoardRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = () => {
      setPathname(window.location.pathname);
      setRouteState(parseBoardRoute(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const isTeacherRoute = pathname === "/teacher" || pathname.startsWith("/teacher/");

  // Only redirect root `/` to a random `/b/<id>` in local development (`import.meta.env.DEV`).
  // In production, `/` displays the prompt to open the board link sent by the teacher (T2.5b section B.9).
  useEffect(() => {
    if (!isTeacherRoute && !routeState.matchedRoute && isDevEnvironment) {
      const generatedId = generateBoardId();
      const targetPath = `/b/${generatedId}`;
      window.history.replaceState(null, "", targetPath);
      setPathname(targetPath);
      setRouteState(parseBoardRoute(targetPath));
    }
  }, [isTeacherRoute, routeState.matchedRoute]);

  if (isTeacherRoute) {
    return (
      <Suspense
        fallback={
          <div className="board-loading-screen" role="status">
            {RU_STRINGS.loadingCanvas}
          </div>
        }
      >
        <TeacherCabinet />
      </Suspense>
    );
  }

  if (routeState.matchedRoute && routeState.boardId) {
    return (
      <Suspense
        fallback={
          <div className="board-loading-screen" role="status">
            {RU_STRINGS.loadingCanvas}
          </div>
        }
      >
        <BoardView boardId={routeState.boardId} />
      </Suspense>
    );
  }

  if (routeState.matchedRoute && !routeState.boardId) {
    return (
      <main className="board-empty-state" role="main">
        <h1 className="board-empty-title">{RU_STRINGS.invalidBoardUrlTitle}</h1>
        <p className="board-empty-desc">{RU_STRINGS.invalidBoardUrlDescription}</p>
        <div style={{ marginTop: "16px" }}>
          <a href="/teacher" className="board-btn board-btn-primary">
            {RU_STRINGS.goToTeacherCabinet}
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="board-empty-state" role="main">
      <h1 className="board-empty-title">{RU_STRINGS.openTeacherBoardLinkTitle}</h1>
      <p className="board-empty-desc">{RU_STRINGS.openTeacherBoardLinkDescription}</p>
      <div style={{ marginTop: "20px" }}>
        <a href="/teacher" className="board-btn board-btn-primary">
          {RU_STRINGS.goToTeacherCabinet}
        </a>
      </div>
    </main>
  );
}
