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
}

const STORAGE_KEY_TOKEN = "board.teacherToken";

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
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
    </div>
  );
}
