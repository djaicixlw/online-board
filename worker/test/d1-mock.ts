/**
 * worker/test/d1-mock.ts
 * Pure TypeScript in-memory mock for Cloudflare D1Database.
 * Emulates `teachers`, `students`, and `boards` tables for Vitest.
 */

export interface MockTeacher {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
}

export interface MockStudent {
  id: string;
  teacher_id: string;
  nickname: string;
  notes: string;
  archived: number;
  created_at: number;
}

export interface MockBoard {
  id: string;
  teacher_id: string;
  student_id: string | null;
  title: string;
  notes: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  last_backup_at: number | null;
}

export class InMemoryD1Database {
  public teachers = new Map<string, MockTeacher>();
  public students = new Map<string, MockStudent>();
  public boards = new Map<string, MockBoard>();

  prepare(query: string) {
    let bound: unknown[] = [];
    const teachersMap = this.teachers;
    const studentsMap = this.students;
    const boardsMap = this.boards;

    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async first<T = Record<string, unknown>>() {
        const { results } = await this.all<T>();
        return results[0] ?? null;
      },
      async all<T = Record<string, unknown>>() {
        const q = query.trim();

        // 1. SELECT id, name FROM teachers WHERE token_hash = ?1
        if (/SELECT id, name FROM teachers WHERE token_hash/i.test(q)) {
          const hash = String(bound[0]);
          for (const t of teachersMap.values()) {
            if (t.token_hash === hash) {
              return { results: [{ id: t.id, name: t.name }] as T[], success: true };
            }
          }
          return { results: [] as T[], success: true };
        }

        // 2. SELECT 1 FROM boards WHERE id = ?1 AND deleted_at IS NULL
        if (/SELECT 1 FROM boards WHERE id = \?1 AND deleted_at IS NULL/i.test(q)) {
          const id = String(bound[0]);
          const b = boardsMap.get(id);
          if (b && b.deleted_at === null) {
            return { results: [{ "1": 1 }] as T[], success: true };
          }
          return { results: [] as T[], success: true };
        }

        // 3. SELECT ... FROM students WHERE teacher_id = ?1
        if (/SELECT .* FROM students WHERE teacher_id = \?1/i.test(q)) {
          const teacherId = String(bound[0]);
          const includeArchived = !/AND archived = 0/i.test(q);
          const list = Array.from(studentsMap.values())
            .filter((s) => s.teacher_id === teacherId && (includeArchived || s.archived === 0))
            .sort((a, b) => {
              if (a.archived !== b.archived) return a.archived - b.archived;
              return a.nickname.localeCompare(b.nickname);
            });
          return { results: list as T[], success: true };
        }

        // 4. SELECT ... FROM students WHERE id = ?1 AND teacher_id = ?2
        if (/SELECT .* FROM students WHERE id = \?1 AND teacher_id = \?2/i.test(q)) {
          const id = String(bound[0]);
          const teacherId = String(bound[1]);
          const s = studentsMap.get(id);
          if (s && s.teacher_id === teacherId) {
            return { results: [s] as T[], success: true };
          }
          return { results: [] as T[], success: true };
        }

        // 5. SELECT id FROM students WHERE id = ?1 AND teacher_id = ?2 LIMIT 1
        if (/SELECT id FROM students WHERE id = \?1 AND teacher_id = \?2/i.test(q)) {
          const id = String(bound[0]);
          const teacherId = String(bound[1]);
          const s = studentsMap.get(id);
          if (s && s.teacher_id === teacherId) {
            return { results: [{ id: s.id }] as T[], success: true };
          }
          return { results: [] as T[], success: true };
        }

        // 6. SELECT ... FROM boards WHERE teacher_id = ?1 (with optional student_id)
        if (/SELECT .* FROM boards WHERE teacher_id = \?1/i.test(q)) {
          const teacherId = String(bound[0]);
          const hasStudentFilter = /AND student_id = \?2/i.test(q);
          const studentId = hasStudentFilter ? String(bound[1]) : null;

          const list = Array.from(boardsMap.values())
            .filter((b) => {
              if (b.teacher_id !== teacherId) return false;
              if (b.deleted_at !== null) return false;
              if (hasStudentFilter && b.student_id !== studentId) return false;
              return true;
            })
            .sort((a, b) => b.updated_at - a.updated_at);
          return { results: list as T[], success: true };
        }

        // 7. SELECT ... FROM boards WHERE id = ?1 AND teacher_id = ?2 AND deleted_at IS NULL
        if (
          /SELECT .* FROM boards WHERE id = \?1 AND teacher_id = \?2 AND deleted_at IS NULL/i.test(
            q,
          )
        ) {
          const id = String(bound[0]);
          const teacherId = String(bound[1]);
          const b = boardsMap.get(id);
          if (b && b.teacher_id === teacherId && b.deleted_at === null) {
            return { results: [b] as T[], success: true };
          }
          return { results: [] as T[], success: true };
        }

        return { results: [] as T[], success: true };
      },
      async run() {
        const q = query.trim();

        // INSERT INTO teachers
        if (/INSERT INTO teachers/i.test(q)) {
          const [id, name, token_hash, created_at] = bound as [string, string, string, number];
          teachersMap.set(id, { id, name, token_hash, created_at });
          return { success: true };
        }

        // INSERT INTO students
        if (/INSERT INTO students/i.test(q)) {
          const [id, teacher_id, nickname, notes, created_at] = bound as [
            string,
            string,
            string,
            string,
            number,
          ];
          studentsMap.set(id, {
            id,
            teacher_id,
            nickname,
            notes,
            archived: 0,
            created_at,
          });
          return { success: true };
        }

        // UPDATE students
        if (
          /UPDATE students SET nickname = \?1, notes = \?2, archived = \?3 WHERE id = \?4 AND teacher_id = \?5/i.test(
            q,
          )
        ) {
          const [nickname, notes, archived, id, teacher_id] = bound as [
            string,
            string,
            number,
            string,
            string,
          ];
          const s = studentsMap.get(id);
          if (s && s.teacher_id === teacher_id) {
            s.nickname = nickname;
            s.notes = notes;
            s.archived = archived;
          }
          return { success: true };
        }

        // INSERT INTO boards
        if (/INSERT INTO boards/i.test(q)) {
          const [id, teacher_id, student_id, title, created_at] = bound as [
            string,
            string,
            string | null,
            string,
            number,
          ];
          boardsMap.set(id, {
            id,
            teacher_id,
            student_id,
            title,
            notes: "",
            deleted_at: null,
            created_at,
            updated_at: created_at,
            last_backup_at: null,
          });
          return { success: true };
        }

        // UPDATE boards (soft delete)
        if (
          /UPDATE boards SET deleted_at = \?1, updated_at = \?1 WHERE id = \?2 AND teacher_id = \?3/i.test(
            q,
          )
        ) {
          const [deleted_at, id, teacher_id] = bound as [number, string, string];
          const b = boardsMap.get(id);
          if (b && b.teacher_id === teacher_id) {
            b.deleted_at = deleted_at;
            b.updated_at = deleted_at;
          }
          return { success: true };
        }

        // UPDATE boards (edit)
        if (
          /UPDATE boards SET title = \?1, notes = \?2, student_id = \?3, updated_at = \?4 WHERE id = \?5 AND teacher_id = \?6/i.test(
            q,
          )
        ) {
          const [title, notes, student_id, updated_at, id, teacher_id] = bound as [
            string,
            string,
            string | null,
            number,
            string,
            string,
          ];
          const b = boardsMap.get(id);
          if (b && b.teacher_id === teacher_id) {
            b.title = title;
            b.notes = notes;
            b.student_id = student_id;
            b.updated_at = updated_at;
          }
          return { success: true };
        }

        return { success: true };
      },
    };
  }

  async exec(_query: string) {
    return { count: 1, duration: 0 };
  }
}
