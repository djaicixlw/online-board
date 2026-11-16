import { useCallback, useEffect, useRef, useState } from "react";
import { RU_STRINGS } from "../i18n/ru.js";
import "./teacher.css";

interface Teacher {
  id: string;
  name: string;
}

interface Student {
  id: string;
  teacher_id: string;
  nickname: string;
  notes: string;
  archived: number;
  created_at: number;
}

interface BoardItem {
  id: string;
  teacher_id: string;
  student_id: string | null;
  title: string;
  notes: string;
  created_at: number;
  updated_at: number;
  last_backup_at?: number | null;
}

const STORAGE_KEY_TOKEN = "board.teacherToken";

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TeacherCabinet() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY_TOKEN));
  const [tokenInput, setTokenInput] = useState<string>("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [teacher, setTeacher] = useState<Teacher | null>(null);

  const [students, setStudents] = useState<Student[]>([]);
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(null);
  const [newStudentNick, setNewStudentNick] = useState<string>("");
  const [isAddingStudent, setIsAddingStudent] = useState<boolean>(false);

  const [boards, setBoards] = useState<BoardItem[]>([]);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Backup & restore modal states (T5)
  const [restoreModalBoard, setRestoreModalBoard] = useState<BoardItem | null>(null);
  const [localBackupInfo, setLocalBackupInfo] = useState<{
    backed_up_at: number;
    element_count: number;
  } | null>(null);
  const [gitBackupsList, setGitBackupsList] = useState<
    Array<{ sha: string; message: string; date: string; author: string }>
  >([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState<boolean>(false);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);

  // Student notes debounced autosave state
  const [studentNotesDraft, setStudentNotesDraft] = useState<string>("");
  const [studentNotesStatus, setStudentNotesStatus] = useState<string>("");
  const studentNotesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Board notes drafts
  const [boardNotesDrafts, setBoardNotesDrafts] = useState<Record<string, string>>({});
  const boardNotesTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((cur) => (cur === msg ? null : cur));
    }, 3000);
  }, []);

  const authFetch = useCallback(
    async (path: string, options: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(options.headers);
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      return fetch(path, { ...options, headers });
    },
    [token],
  );

  // Load teacher info
  useEffect(() => {
    if (!token) {
      setTeacher(null);
      return;
    }

    let isMounted = true;
    authFetch("/api/me")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("Unauthorized");
        }
        return res.json() as Promise<{ ok: boolean; teacher: Teacher }>;
      })
      .then((data) => {
        if (isMounted && data.ok) {
          setTeacher(data.teacher);
          setAuthError(null);
        }
      })
      .catch(() => {
        if (isMounted) {
          localStorage.removeItem(STORAGE_KEY_TOKEN);
          setToken(null);
          setTeacher(null);
          setAuthError(RU_STRINGS.teacherLoginError);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [token, authFetch]);

  // Load students
  const loadStudents = useCallback(async () => {
    if (!token) return;
    try {
      const res = await authFetch(`/api/students?include_archived=${showArchived ? "1" : "0"}`);
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; students: Student[] };
        setStudents(data.students || []);
      }
    } catch {
      // Ignore network errors
    }
  }, [token, showArchived, authFetch]);

  useEffect(() => {
    if (teacher) {
      loadStudents();
    }
  }, [teacher, loadStudents]);

  // Load boards
  const loadBoards = useCallback(async () => {
    if (!token) return;
    try {
      const path = selectedStudentId
        ? `/api/boards?student_id=${selectedStudentId}`
        : "/api/boards";
      const res = await authFetch(path);
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; boards: BoardItem[] };
        setBoards(data.boards || []);
        const drafts: Record<string, string> = {};
        for (const b of data.boards || []) {
          drafts[b.id] = b.notes || "";
        }
        setBoardNotesDrafts(drafts);
      }
    } catch {
      // Ignore network errors
    }
  }, [token, selectedStudentId, authFetch]);

  useEffect(() => {
    if (teacher) {
      loadBoards();
    }
  }, [teacher, loadBoards]);

  // Update selected student notes draft
  useEffect(() => {
    if (!selectedStudentId) {
      setStudentNotesDraft("");
      return;
    }
    const student = students.find((s) => s.id === selectedStudentId);
    setStudentNotesDraft(student?.notes || "");
  }, [selectedStudentId, students]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanToken = tokenInput.trim();
    if (!cleanToken) return;
    localStorage.setItem(STORAGE_KEY_TOKEN, cleanToken);
    setToken(cleanToken);
  };

  const handleLogout = () => {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
    setToken(null);
    setTeacher(null);
    setTokenInput("");
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanNick = newStudentNick.trim();
    if (!cleanNick) return;
    try {
      const res = await authFetch("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: cleanNick }),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; student: Student };
        setStudents((prev) => [data.student, ...prev]);
        setSelectedStudentId(data.student.id);
        setNewStudentNick("");
        setIsAddingStudent(false);
      }
    } catch {
      // Ignore
    }
  };

  const handleStudentNotesChange = (text: string) => {
    setStudentNotesDraft(text);
    setStudentNotesStatus(RU_STRINGS.savingStatus);
    if (studentNotesTimerRef.current) {
      clearTimeout(studentNotesTimerRef.current);
    }
    if (!selectedStudentId) return;

    const studentId = selectedStudentId;
    studentNotesTimerRef.current = setTimeout(async () => {
      try {
        await authFetch(`/api/students/${studentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: text }),
        });
        setStudentNotesStatus(RU_STRINGS.savedStatus);
        setStudents((prev) => prev.map((s) => (s.id === studentId ? { ...s, notes: text } : s)));
      } catch {
        setStudentNotesStatus("");
      }
    }, 600);
  };

  const handleToggleArchiveStudent = async (student: Student) => {
    const nextArchived = student.archived ? 0 : 1;
    try {
      await authFetch(`/api/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: nextArchived }),
      });
      loadStudents();
    } catch {
      // Ignore
    }
  };

  const handleCreateBoardOneClick = async () => {
    const nowTs = Date.now();
    const dateStr = formatDate(nowTs);
    const selectedStudent = students.find((s) => s.id === selectedStudentId);
    const title = selectedStudent
      ? `${selectedStudent.nickname} — ${dateStr}`
      : `Новая доска — ${dateStr}`;

    try {
      const res = await authFetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          student_id: selectedStudentId || undefined,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; board: BoardItem };
        const boardUrl = `${window.location.origin}/b/${data.board.id}`;
        try {
          await navigator.clipboard.writeText(boardUrl);
        } catch {
          // Fallback if clipboard API restricted
        }
        showToast(RU_STRINGS.boardCreatedToast);
        setBoards((prev) => [data.board, ...prev]);
        setBoardNotesDrafts((prev) => ({ ...prev, [data.board.id]: "" }));
      }
    } catch {
      // Ignore
    }
  };

  const handleCopyLink = async (boardId: string) => {
    const url = `${window.location.origin}/b/${boardId}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast(RU_STRINGS.linkCopiedToast);
    } catch {
      showToast(url);
    }
  };

  const handleDuplicateBoard = async (board: BoardItem) => {
    try {
      const res = await authFetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${board.title} (копия)`,
          student_id: board.student_id || undefined,
          from_board_id: board.id,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; board: BoardItem };
        setBoards((prev) => [data.board, ...prev]);
        setBoardNotesDrafts((prev) => ({ ...prev, [data.board.id]: "" }));
        showToast("Доска успешно скопирована!");
      }
    } catch {
      // Ignore
    }
  };

  const handleDeleteBoard = async (boardId: string) => {
    if (!window.confirm(RU_STRINGS.deleteBoardConfirm)) return;
    try {
      const res = await authFetch(`/api/boards/${boardId}`, { method: "DELETE" });
      if (res.ok) {
        setBoards((prev) => prev.filter((b) => b.id !== boardId));
      }
    } catch {
      // Ignore
    }
  };

  const handleOpenRestoreModal = useCallback(
    async (b: BoardItem) => {
      setRestoreModalBoard(b);
      setIsLoadingBackups(true);
      setLocalBackupInfo(null);
      setGitBackupsList([]);
      try {
        const res = await authFetch(`/api/boards/${b.id}/backups`);
        if (res.ok) {
          const data = (await res.json()) as {
            ok: boolean;
            local_backup: { backed_up_at: number; element_count: number } | null;
            git_backups: Array<{ sha: string; message: string; date: string; author: string }>;
          };
          if (data.ok) {
            setLocalBackupInfo(data.local_backup);
            setGitBackupsList(data.git_backups || []);
          }
        }
      } catch (err) {
        console.error("Error fetching backups:", err);
      } finally {
        setIsLoadingBackups(false);
      }
    },
    [authFetch],
  );

  const handleExecuteRestore = useCallback(
    async (source: "local_backup" | "git", ref?: string) => {
      if (!restoreModalBoard) return;
      if (!window.confirm(RU_STRINGS.restoreConfirmMessage)) return;
      setIsRestoring(true);
      try {
        const res = await authFetch(`/api/boards/${restoreModalBoard.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            source === "local_backup" ? { source: "local_backup" } : { source: "git", ref },
          ),
        });
        if (res.ok) {
          showToast(RU_STRINGS.restoreSuccessToast);
          setRestoreModalBoard(null);
          loadBoards();
        } else {
          showToast(RU_STRINGS.restoreFailedToast);
        }
      } catch {
        showToast(RU_STRINGS.restoreFailedToast);
      } finally {
        setIsRestoring(false);
      }
    },
    [restoreModalBoard, authFetch, showToast, loadBoards],
  );

  const handleImportExcalidraw = useCallback(
    async (boardId: string, file: File) => {
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as { elements?: unknown[] };
        if (!parsed || !Array.isArray(parsed.elements)) {
          showToast(RU_STRINGS.fileImportError);
          return;
        }
        const res = await authFetch(`/api/boards/${boardId}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "file",
            elements: parsed.elements,
          }),
        });
        if (res.ok) {
          showToast(RU_STRINGS.importSuccessToast);
          loadBoards();
        } else {
          showToast(RU_STRINGS.restoreFailedToast);
        }
      } catch {
        showToast(RU_STRINGS.fileImportError);
      }
    },
    [authFetch, showToast, loadBoards],
  );

  const handleBoardNotesChange = (boardId: string, text: string) => {
    setBoardNotesDrafts((prev) => ({ ...prev, [boardId]: text }));
    if (boardNotesTimersRef.current[boardId]) {
      clearTimeout(boardNotesTimersRef.current[boardId]);
    }
    boardNotesTimersRef.current[boardId] = setTimeout(async () => {
      try {
        await authFetch(`/api/boards/${boardId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: text }),
        });
      } catch {
        // Ignore
      }
    }, 600);
  };

  // If not authenticated, show login form
  if (!teacher) {
    return (
      <div className="teacher-login-container">
        <div className="teacher-login-card">
          <h1 className="teacher-login-title">{RU_STRINGS.teacherLoginTitle}</h1>
          <p className="teacher-login-subtitle">{RU_STRINGS.teacherLoginSubtitle}</p>
          <form onSubmit={handleLogin}>
            <label htmlFor="teacher-token" className="teacher-label">
              {RU_STRINGS.teacherTokenLabel}
            </label>
            <input
              id="teacher-token"
              type="password"
              className="teacher-input"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={RU_STRINGS.teacherTokenPlaceholder}
              autoFocus
            />
            {authError && <div className="teacher-error">{authError}</div>}
            <button type="submit" className="button-primary teacher-login-btn">
              {RU_STRINGS.teacherLoginButton}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const selectedStudent = students.find((s) => s.id === selectedStudentId);

  return (
    <div className="teacher-cabinet">
      {toastMessage && <div className="teacher-toast">{toastMessage}</div>}

      <header className="teacher-header">
        <div className="teacher-header-left">
          <h1 className="teacher-title">{RU_STRINGS.teacherCabinetTitle}</h1>
          <span className="teacher-name">{teacher.name}</span>
        </div>
        <div className="teacher-header-right">
          <button type="button" className="button-secondary" onClick={handleLogout}>
            {RU_STRINGS.teacherLogoutButton}
          </button>
        </div>
      </header>

      <div className="teacher-layout">
        {/* Sidebar: Students */}
        <aside className="teacher-sidebar">
          <div className="sidebar-header">
            <h2>{RU_STRINGS.studentsTitle}</h2>
            <button
              type="button"
              className="button-primary-sm"
              onClick={() => setIsAddingStudent((prev) => !prev)}
            >
              {RU_STRINGS.addStudentButton}
            </button>
          </div>

          {isAddingStudent && (
            <form onSubmit={handleAddStudent} className="add-student-form">
              <input
                type="text"
                className="teacher-input-sm"
                placeholder={RU_STRINGS.studentNickPlaceholder}
                value={newStudentNick}
                onChange={(e) => setNewStudentNick(e.target.value)}
                autoFocus
              />
              <div className="add-student-actions">
                <button type="submit" className="button-primary-sm">
                  OK
                </button>
                <button
                  type="button"
                  className="button-secondary-sm"
                  onClick={() => setIsAddingStudent(false)}
                >
                  ×
                </button>
              </div>
            </form>
          )}

          <div className="students-filter-bar">
            <button
              type="button"
              className={`filter-chip ${selectedStudentId === null ? "active" : ""}`}
              onClick={() => setSelectedStudentId(null)}
            >
              {RU_STRINGS.allStudentsFilter}
            </button>
            <button
              type="button"
              className="toggle-archived-btn"
              onClick={() => setShowArchived((prev) => !prev)}
            >
              {showArchived ? RU_STRINGS.hideArchivedStudents : RU_STRINGS.showArchivedStudents}
            </button>
          </div>

          <ul className="students-list">
            {students.map((st) => (
              <li
                key={st.id}
                className={`student-item ${st.id === selectedStudentId ? "active" : ""} ${
                  st.archived ? "archived" : ""
                }`}
                onClick={() => setSelectedStudentId(st.id)}
              >
                <span className="student-nick">{st.nickname}</span>
                <button
                  type="button"
                  className="archive-btn"
                  title={
                    st.archived
                      ? RU_STRINGS.unarchiveStudentButton
                      : RU_STRINGS.archiveStudentButton
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleArchiveStudent(st);
                  }}
                >
                  {st.archived ? "↺" : "🗄️"}
                </button>
              </li>
            ))}
            {students.length === 0 && (
              <li className="no-items-label">{RU_STRINGS.noStudentsMessage}</li>
            )}
          </ul>

          {selectedStudent && (
            <div className="student-notes-section">
              <div className="student-notes-header">
                <h3>Заметки к ученику</h3>
                {studentNotesStatus && <span className="save-status">{studentNotesStatus}</span>}
              </div>
              <textarea
                className="teacher-textarea"
                rows={4}
                value={studentNotesDraft}
                onChange={(e) => handleStudentNotesChange(e.target.value)}
                placeholder={RU_STRINGS.studentNotesPlaceholder}
              />
            </div>
          )}
        </aside>

        {/* Main Content: Boards */}
        <main className="teacher-main">
          <div className="boards-top-bar">
            <div className="boards-title-wrap">
              <h2>
                {RU_STRINGS.boardsTitle}
                {selectedStudent ? ` — ${selectedStudent.nickname}` : ""}
              </h2>
              <span className="boards-count">Всего: {boards.length}</span>
            </div>
            <button
              type="button"
              className="button-primary create-board-btn"
              onClick={handleCreateBoardOneClick}
            >
              ⚡ {RU_STRINGS.createBoardOneClick}
            </button>
          </div>

          <div className="boards-grid">
            {boards.map((b) => {
              const linkedStudent = students.find((s) => s.id === b.student_id);
              return (
                <article key={b.id} className="board-card">
                  <div className="board-card-header">
                    <h3 className="board-card-title">{b.title}</h3>
                    <div className="board-card-meta">
                      {linkedStudent && (
                        <span className="student-badge">{linkedStudent.nickname}</span>
                      )}
                      <span className="board-date">{formatDate(b.created_at)}</span>
                      <span
                        className="board-backup-status"
                        title={
                          b.last_backup_at ? new Date(b.last_backup_at).toLocaleString("ru-RU") : ""
                        }
                      >
                        {b.last_backup_at
                          ? `${RU_STRINGS.backupStatusPrefix} ${formatDateTime(b.last_backup_at)}`
                          : RU_STRINGS.noBackupText}
                      </span>
                    </div>
                  </div>

                  <textarea
                    className="board-notes-input"
                    rows={2}
                    value={boardNotesDrafts[b.id] ?? b.notes ?? ""}
                    onChange={(e) => handleBoardNotesChange(b.id, e.target.value)}
                    placeholder={RU_STRINGS.boardNotesPlaceholder}
                  />

                  <div className="board-card-actions">
                    <a
                      href={`/b/${b.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="button-primary-sm"
                    >
                      {RU_STRINGS.openBoardButton}
                    </a>
                    <button
                      type="button"
                      className="button-secondary-sm"
                      onClick={() => handleCopyLink(b.id)}
                    >
                      {RU_STRINGS.copyBoardLinkButton}
                    </button>
                    <button
                      type="button"
                      className="button-secondary-sm"
                      onClick={() => handleDuplicateBoard(b)}
                    >
                      {RU_STRINGS.duplicateBoardButton}
                    </button>
                    <button
                      type="button"
                      className="button-secondary-sm"
                      onClick={() => handleOpenRestoreModal(b)}
                    >
                      {RU_STRINGS.restoreBoardButton}
                    </button>
                    <label className="button-secondary-sm board-import-label">
                      {RU_STRINGS.importBoardButton}
                      <input
                        type="file"
                        accept=".excalidraw,application/json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            handleImportExcalidraw(b.id, file);
                            e.target.value = "";
                          }
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="button-danger-sm"
                      onClick={() => handleDeleteBoard(b.id)}
                    >
                      {RU_STRINGS.deleteBoardButton}
                    </button>
                  </div>
                </article>
              );
            })}
            {boards.length === 0 && (
              <div className="no-boards-card">
                <p>{RU_STRINGS.noBoardsMessage}</p>
              </div>
            )}
          </div>
        </main>
      </div>

      {restoreModalBoard && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2 className="modal-title">{RU_STRINGS.restoreModalTitle}</h2>
            <p className="modal-subtitle">
              {RU_STRINGS.restoreModalSubtitle} ({restoreModalBoard.title})
            </p>

            <div className="restore-sections">
              <div className="restore-section">
                <h3>{RU_STRINGS.localBackupTitle}</h3>
                {localBackupInfo ? (
                  <div className="restore-backup-row">
                    <div>
                      <strong>{formatDateTime(localBackupInfo.backed_up_at)}</strong>
                      <span className="restore-element-count">
                        ({localBackupInfo.element_count} элементов)
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button-primary-sm"
                      disabled={isRestoring}
                      onClick={() => handleExecuteRestore("local_backup")}
                    >
                      {RU_STRINGS.restoreFromLocalButton}
                    </button>
                  </div>
                ) : (
                  <p className="restore-empty-text">
                    {isLoadingBackups ? "Загрузка..." : RU_STRINGS.noLocalBackupText}
                  </p>
                )}
              </div>

              <div className="restore-section">
                <h3>{RU_STRINGS.gitBackupsTitle}</h3>
                {gitBackupsList.length > 0 ? (
                  <div className="restore-git-list">
                    {gitBackupsList.map((c) => (
                      <div key={c.sha} className="restore-backup-row">
                        <div className="restore-git-meta">
                          <code className="restore-commit-sha">{c.sha.slice(0, 7)}</code>
                          <span className="restore-commit-msg">{c.message}</span>
                          <span className="restore-commit-date">
                            {new Date(c.date).toLocaleDateString("ru-RU")}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="button-secondary-sm"
                          disabled={isRestoring}
                          onClick={() => handleExecuteRestore("git", c.sha)}
                        >
                          {RU_STRINGS.restoreFromGitButton}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="restore-empty-text">
                    {isLoadingBackups ? "Загрузка..." : RU_STRINGS.noGitBackupsText}
                  </p>
                )}
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={isRestoring}
                onClick={() => setRestoreModalBoard(null)}
              >
                {RU_STRINGS.nickCancelButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
