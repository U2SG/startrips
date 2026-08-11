import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { authClient } from "./auth-client";

type OrganizationSummary = {
  id: string;
  name: string;
  slug: string;
};

type AtlasSummary = {
  id: string;
  title: string;
  dedication: string;
};

type GateState =
  | { kind: "loading" }
  | { kind: "create-organization" }
  | { kind: "choose-organization"; organizations: OrganizationSummary[] }
  | { kind: "bootstrap"; organization: OrganizationSummary }
  | { kind: "ready"; atlas: AtlasSummary; role: string }
  | { kind: "error"; message: string };

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as {
    error?: string;
    message?: string;
  } | null;
  return payload?.message || payload?.error || `Request failed (${response.status})`;
}

function AuthForm({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    try {
      if (mode === "forgot") {
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (result.error) throw new Error(result.error.message);
        setMessage("如果这个邮箱已注册，重置链接已经发送。");
        return;
      }

      if (mode === "sign-up") {
        const result = await authClient.signUp.email({
          name: name.trim(),
          email: email.trim(),
          password,
          callbackURL: window.location.href,
        });
        if (result.error) throw new Error(result.error.message);
        setMessage("验证邮件已发送。完成邮箱验证后即可进入。 ");
        return;
      }

      const result = await authClient.signIn.email({
        email: email.trim(),
        password,
        callbackURL: window.location.href,
      });
      if (result.error) throw new Error(result.error.message);
      onAuthenticated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "认证失败，请重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-gate">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="auth-eyebrow">STARTRIPS · PRIVATE ATLAS</p>
        <h1 id="auth-title">
          {mode === "sign-in" ? "进入你们的星轨" : mode === "sign-up" ? "创建私人入口" : "重置密码"}
        </h1>
        <p className="auth-copy">一个账号只创建一份私人图谱，最多邀请另一位共同编辑。</p>

        <form onSubmit={submit}>
          {mode === "sign-up" ? (
            <label>
              <span>你的名字</span>
              <input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          ) : null}
          <label>
            <span>邮箱</span>
            <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          {mode !== "forgot" ? (
            <label>
              <span>密码</span>
              <input required minLength={10} maxLength={128} type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
          ) : null}
          <button className="auth-primary" type="submit" disabled={pending}>
            {pending ? "请稍候…" : mode === "sign-in" ? "登录" : mode === "sign-up" ? "注册并验证邮箱" : "发送重置链接"}
          </button>
        </form>

        {message ? <p className="auth-message" role="status">{message}</p> : null}
        <div className="auth-switches">
          <button type="button" onClick={() => setMode(mode === "sign-up" ? "sign-in" : "sign-up")}>
            {mode === "sign-up" ? "已有账号，去登录" : "没有账号，先注册"}
          </button>
          <button type="button" onClick={() => setMode(mode === "forgot" ? "sign-in" : "forgot")}>
            {mode === "forgot" ? "返回登录" : "忘记密码"}
          </button>
        </div>
      </section>
    </main>
  );
}

function ResetPassword() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    const result = await authClient.resetPassword({ token, newPassword: password });
    setPending(false);
    if (result.error || !result.data) {
      setMessage(result.error?.message || "邀请已失效");
      return;
    }
    setMessage("密码已更新，现在可以返回登录。");
  }

  return (
    <main className="auth-gate">
      <section className="auth-card">
        <p className="auth-eyebrow">STARTRIPS · ACCOUNT RECOVERY</p>
        <h1>设置新密码</h1>
        {token ? (
          <form onSubmit={submit}>
            <label>
              <span>新密码</span>
              <input required minLength={10} maxLength={128} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button className="auth-primary" type="submit" disabled={pending}>{pending ? "请稍候…" : "更新密码"}</button>
          </form>
        ) : <p className="auth-message">重置链接无效或缺少 token。</p>}
        {message ? <p className="auth-message" role="status">{message}</p> : null}
        <a className="auth-link" href="/">返回登录</a>
      </section>
    </main>
  );
}

function InvitationGate({ invitationId, onAccepted }: { invitationId: string; onAccepted: () => void }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function accept() {
    setPending(true);
    setMessage("");
    const result = await authClient.organization.acceptInvitation({ invitationId });
    if (result.error || !result.data) {
      setMessage(result.error?.message || "邀请已失效");
      setPending(false);
      return;
    }
    const activated = await authClient.organization.setActive({
      organizationId: result.data.invitation.organizationId,
    });
    if (activated.error) {
      setMessage(activated.error.message || "已经加入，但暂时无法切换到这份图谱");
      setPending(false);
      return;
    }
    window.history.replaceState({}, "", "/");
    setPending(false);
    onAccepted();
  }

  return (
    <main className="auth-gate">
      <section className="auth-card">
        <p className="auth-eyebrow">STARTRIPS · INVITATION</p>
        <h1>加入共同图谱</h1>
        <p className="auth-copy">接受后，你将成为这份私人图谱的第二位成员。</p>
        <button className="auth-primary" type="button" disabled={pending} onClick={accept}>{pending ? "正在加入…" : "接受邀请"}</button>
        {message ? <p className="auth-message" role="alert">{message}</p> : null}
      </section>
    </main>
  );
}

function WorkspaceGate({ children, activeOrganizationId, userName }: {
  children: ReactNode;
  activeOrganizationId?: string;
  userName: string;
}) {
  const [gate, setGate] = useState<GateState>({ kind: "loading" });
  const [selectedActiveId, setSelectedActiveId] = useState(activeOrganizationId);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [atlasName, setAtlasName] = useState("");
  const [dedication, setDedication] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");

  useEffect(() => {
    setSelectedActiveId(activeOrganizationId);
  }, [activeOrganizationId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setGate({ kind: "loading" });
      const listed = await authClient.organization.list();
      if (cancelled) return;
      if (listed.error) {
        setGate({ kind: "error", message: listed.error.message || "无法读取图谱列表" });
        return;
      }
      const organizations = listed.data ?? [];
      if (organizations.length === 0) {
        setGate({ kind: "create-organization" });
        return;
      }
      const active = organizations.find((organization) => organization.id === selectedActiveId);
      if (!active) {
        setGate({ kind: "choose-organization", organizations });
        return;
      }

      const response = await fetch("/api/atlases/current", { credentials: "include" });
      if (cancelled) return;
      if (response.ok) {
        const payload = await response.json() as { atlas: AtlasSummary; role: string };
        setGate({ kind: "ready", atlas: payload.atlas, role: payload.role });
        return;
      }
      const error = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (response.status === 404 && error?.error === "ATLAS_NOT_FOUND") {
        setAtlasName(active.name);
        setGate({ kind: "bootstrap", organization: active });
        return;
      }
      setGate({ kind: "error", message: error?.message || error?.error || "无法读取私人图谱" });
    }
    void load();
    return () => { cancelled = true; };
  }, [selectedActiveId, revision]);

  async function createOrganization(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const name = atlasName.trim();
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "atlas";
    const result = await authClient.organization.create({
      name,
      slug: `${slugBase}-${crypto.randomUUID().slice(0, 8)}`,
    });
    if (result.error || !result.data) {
      setMessage(result.error?.message || "无法创建私人图谱");
      setPending(false);
      return;
    }
    const activated = await authClient.organization.setActive({ organizationId: result.data.id });
    if (activated.error) {
      setMessage(activated.error.message || "无法切换私人图谱");
      setPending(false);
      return;
    }
    setSelectedActiveId(result.data.id);
    const response = await fetch("/api/atlases/bootstrap", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name, dedication }),
    });
    if (!response.ok) setMessage(await responseError(response));
    setPending(false);
    setRevision((value) => value + 1);
  }

  async function bootstrapAtlas(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const response = await fetch("/api/atlases/bootstrap", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: atlasName.trim(), dedication }),
    });
    if (!response.ok) setMessage(await responseError(response));
    else setRevision((value) => value + 1);
    setPending(false);
  }

  async function selectOrganization(organizationId: string) {
    setPending(true);
    const result = await authClient.organization.setActive({ organizationId });
    if (result.error) setMessage(result.error.message || "无法切换私人图谱");
    else setSelectedActiveId(organizationId);
    setPending(false);
    setRevision((value) => value + 1);
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setMessage("");
    const result = await authClient.organization.inviteMember({
      email: inviteEmail.trim(),
      role: "member",
    });
    setPending(false);
    if (result.error) {
      setMessage(result.error.message || "无法发送邀请");
      return;
    }
    setInviteEmail("");
    setInviteOpen(false);
    setMessage("邀请邮件已发送。");
  }

  if (gate.kind === "loading") {
    return <main className="auth-gate"><p className="auth-loading">正在打开私人图谱…</p></main>;
  }
  if (gate.kind === "error") {
    return <main className="auth-gate"><section className="auth-card"><h1>暂时无法进入</h1><p className="auth-message">{gate.message}</p><button className="auth-primary" type="button" onClick={() => setRevision((value) => value + 1)}>重试</button></section></main>;
  }
  if (gate.kind === "choose-organization") {
    return (
      <main className="auth-gate"><section className="auth-card"><p className="auth-eyebrow">YOUR PRIVATE ATLAS</p><h1>选择一份图谱</h1><div className="auth-choice-list">{gate.organizations.map((organization) => <button type="button" disabled={pending} key={organization.id} onClick={() => selectOrganization(organization.id)}><strong>{organization.name}</strong><span>进入</span></button>)}</div>{message ? <p className="auth-message">{message}</p> : null}</section></main>
    );
  }
  if (gate.kind === "create-organization" || gate.kind === "bootstrap") {
    const isCreate = gate.kind === "create-organization";
    return (
      <main className="auth-gate"><section className="auth-card"><p className="auth-eyebrow">STARTRIPS · PRIVATE ATLAS</p><h1>{isCreate ? "命名你们的图谱" : "完成图谱初始化"}</h1><p className="auth-copy">它将与账号及另一位受邀成员严格隔离。</p><form onSubmit={isCreate ? createOrganization : bootstrapAtlas}><label><span>图谱名称</span><input required maxLength={80} value={atlasName} onChange={(event) => setAtlasName(event.target.value)} /></label><label><span>题词（可选）</span><textarea maxLength={240} rows={3} value={dedication} onChange={(event) => setDedication(event.target.value)} /></label><button className="auth-primary" type="submit" disabled={pending}>{pending ? "正在创建…" : "创建私人图谱"}</button></form>{message ? <p className="auth-message" role="alert">{message}</p> : null}</section></main>
    );
  }

  const isOwner = gate.role.split(",").includes("owner");
  return (
    <>
      <aside className="account-dock">
        <span><strong>{gate.atlas.title}</strong> · {userName}</span>
        {message ? <small>{message}</small> : null}
        {isOwner ? <button type="button" onClick={() => setInviteOpen((value) => !value)}>邀请另一位</button> : null}
        <button type="button" onClick={() => void authClient.signOut().then(() => window.location.assign("/"))}>退出</button>
        {inviteOpen ? (
          <form onSubmit={invite}>
            <label><span>对方邮箱</span><input required type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /></label>
            <button type="submit" disabled={pending}>发送邀请</button>
          </form>
        ) : null}
      </aside>
      {children}
    </>
  );
}

export function AuthGateway({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const [revision, setRevision] = useState(0);
  const qaBypass = import.meta.env.DEV && new URLSearchParams(window.location.search).has("qaState");

  if (qaBypass) return children;
  if (window.location.pathname === "/reset-password") return <ResetPassword />;
  if (session.isPending) return <main className="auth-gate"><p className="auth-loading">正在验证私人入口…</p></main>;
  if (!session.data) return <AuthForm onAuthenticated={() => void session.refetch()} />;

  const invitationId = new URLSearchParams(window.location.search).get("id");
  if (window.location.pathname === "/accept-invitation" && invitationId) {
    return <InvitationGate key={revision} invitationId={invitationId} onAccepted={() => { setRevision((value) => value + 1); void session.refetch(); }} />;
  }

  return (
    <WorkspaceGate
      key={`${session.data.session.activeOrganizationId ?? "none"}-${revision}`}
      activeOrganizationId={session.data.session.activeOrganizationId ?? undefined}
      userName={session.data.user.name}
    >
      {children}
    </WorkspaceGate>
  );
}
