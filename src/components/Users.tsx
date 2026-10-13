import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../context";
import type { Role, User, UserInput } from "../types";
import { formatAt } from "./TxHistory";
import { Field, Modal } from "./Modal";

const ROLES: Role[] = ["admin", "user", "viewer"];

/** User management (administrators only). */
export function Users() {
  const { t, fail, toast, confirm, user: me } = useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [editing, setEditing] = useState<UserInput | null>(null);
  const load = () => api.listUsers().then(setUsers).catch(fail);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(u: User) {
    if (!(await confirm(t("c.confirmDelete", { name: u.username })))) return;
    try {
      await api.deleteUser(u.id);
      toast(t("c.deleted"));
      void load();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{t("usr.title")}</h3>
          <p className="muted small">{t("usr.roleHint")}</p>
        </div>
        <button
          className="btn small primary"
          onClick={() => setEditing({ username: "", role: "user", active: true, password: "" })}
        >
          {t("usr.new")}
        </button>
      </div>
      <table className="table grid clickable">
        <thead>
          <tr>
            <th>{t("auth.username")}</th>
            <th>{t("auth.fullName")}</th>
            <th>{t("usr.role")}</th>
            <th>{t("usr.active")}</th>
            <th>{t("usr.lastLogin")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} onClick={() => setEditing({ ...u, password: "" })}>
              <td className="strong">
                {u.username} {u.id === me.id && <span className="chip">✓</span>}
              </td>
              <td>{u.fullName}</td>
              <td>{t(`usr.role.${u.role}`)}</td>
              <td>{u.active ? "✓" : "—"}</td>
              <td>{u.lastLogin ? formatAt(u.lastLogin) : "—"}</td>
              <td className="actions">
                {u.id !== me.id && (
                  <button
                    className="btn small ghost danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(u);
                    }}
                  >
                    {t("c.delete")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <UserEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function UserEditor({ value, onClose, onSaved }: { value: UserInput; onClose: () => void; onSaved: () => void }) {
  const { t, fail, toast } = useApp();
  const [v, setV] = useState<UserInput>(value);
  const set = (p: Partial<UserInput>) => setV((x) => ({ ...x, ...p }));
  return (
    <Modal title={v.id ? t("usr.edit") : t("usr.create")} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.saveUser({ ...v, password: v.password || null });
            toast(t("c.saved"));
            onSaved();
          } catch (err) {
            fail(err);
          }
        }}
      >
        <div className="grid-2">
          <Field label={t("auth.username")}>
            <input className="input" autoFocus value={v.username} onChange={(e) => set({ username: e.target.value })} />
          </Field>
          <Field label={t("usr.role")}>
            <select className="input" value={v.role} onChange={(e) => set({ role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`usr.role.${r}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t("auth.fullName")}>
          <input className="input" value={v.fullName ?? ""} onChange={(e) => set({ fullName: e.target.value })} />
        </Field>
        <Field label={t("auth.password")} hint={v.id ? t("usr.passwordKeep") : undefined}>
          <input
            className="input"
            type="password"
            value={v.password ?? ""}
            onChange={(e) => set({ password: e.target.value })}
            autoComplete="new-password"
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={v.active} onChange={(e) => set({ active: e.target.checked })} /> {t("usr.active")}
        </label>
        <footer className="form-actions end">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("c.cancel")}
          </button>
          <button className="btn primary">{t("c.save")}</button>
        </footer>
      </form>
    </Modal>
  );
}
