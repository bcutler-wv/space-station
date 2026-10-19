import { useEffect, useState, type ReactNode } from "react";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { PRODUCT_NAME, authStatusSchema } from "@station/shared";
import { applyTheme, DEFAULT_SEED } from "@station/theme";

type Status = {
  ownerExists: boolean;
  authenticated: boolean;
  recoveryAuthenticated: boolean;
  recoveryMode: "totp" | "password" | null;
  pendingTotpUri: string | null;
  csrfToken: string;
};
let csrfToken = "";
export const csrfHeaders = () => ({ "X-CSRF-Token": csrfToken });
async function status(): Promise<Status> {
  const response = await fetch("/api/auth/status", {
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error(
      "Authentication is unavailable. Check that the server is running.",
    );
  const value = authStatusSchema.parse(await response.json()) as Status;
  csrfToken = value.csrfToken;
  return value;
}
async function post(path: string, body: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Authentication failed. Try again.");
  return result;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [forgotPassword, setForgotPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [resetUri, setResetUri] = useState<string | null>(null);
  useEffect(() => {
    void status()
      .then(setAuth)
      .catch((issue: Error) => setError(issue.message));
  }, []);
  useEffect(() => {
    if (!auth || auth.authenticated) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme(DEFAULT_SEED, media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [auth?.authenticated]);
  async function run(
    action: () => Promise<unknown>,
    after?: (value: unknown) => void,
  ) {
    setBusy(true);
    setError("");
    try {
      const value = await action();
      after?.(value);
      setAuth(await status());
    } catch (issue) {
      setError(
        issue instanceof Error
          ? issue.message
          : "Authentication failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (recoveryCodes)
    return (
      <main className="auth-page">
        <section className="auth-card">
          <span className="auth-mark">◉</span>
          <h1>Save your recovery codes</h1>
          <p>
            Store these codes somewhere private. Each code works once. This is
            the only time they are shown.
          </p>
          <div className="recovery-list" aria-label="Recovery codes">
            {recoveryCodes.map((item) => (
              <code key={item}>{item}</code>
            ))}
          </div>
          <button
            className="button primary"
            onClick={() => setRecoveryCodes(null)}
          >
            I saved my codes
          </button>
        </section>
      </main>
    );
  if (auth?.recoveryAuthenticated)
    return (
      <main className="auth-page">
        <section className="auth-card">
          <h1>
            {auth.recoveryMode === "password"
              ? "Set a new password"
              : "Replace your authenticator"}
          </h1>
          <p>
            {auth.recoveryMode === "password"
              ? "Choose a new password. Existing sessions and recovery codes will be revoked."
              : "Connect a new authenticator to finish recovery. Your old codes and sessions will be revoked."}
          </p>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {auth.recoveryMode === "password" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () =>
                    post("reset/password", {
                      password: newPassword,
                      confirmPassword,
                    }),
                  (value) =>
                    setRecoveryCodes(
                      (value as { recoveryCodes: string[] }).recoveryCodes,
                    ),
                );
              }}
            >
              <label>
                New password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                />
              </label>
              <button className="button primary" disabled={busy}>
                Set new password
              </button>
            </form>
          ) : resetUri ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () => post("reset/totp/confirm", { code }),
                  (value) =>
                    setRecoveryCodes(
                      (value as { recoveryCodes: string[] }).recoveryCodes,
                    ),
                );
              }}
            >
              <label>
                Authenticator setup URI
                <input
                  readOnly
                  value={resetUri}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <label>
                Six-digit code
                <input
                  value={code}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </label>
              <button className="button primary" disabled={busy}>
                Confirm new authenticator
              </button>
            </form>
          ) : (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => post("reset/totp/options", {}),
                  (value) =>
                    setResetUri((value as { totpUri: string }).totpUri),
                )
              }
            >
              Start reset
            </button>
          )}
        </section>
      </main>
    );
  if (auth?.authenticated) return <>{children}</>;
  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="auth-mark" aria-hidden="true">
          ◉
        </span>
        <p className="auth-eyebrow">{PRODUCT_NAME}</p>
        <h1>
          {auth?.pendingTotpUri
            ? "Connect your authenticator"
            : auth?.ownerExists
              ? "Sign in"
              : "Create your login"}
        </h1>
        <p className="muted">
          {auth?.pendingTotpUri
            ? "Add this account to your authenticator, then enter its six-digit code."
            : auth?.ownerExists
              ? "Use your passkey or your password and authenticator code."
              : "Get a one-time setup token from the local setup command, then choose a passkey or a password."}
        </p>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        {!auth && !error && <p>Loading…</p>}
        {auth?.pendingTotpUri && (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(
                  () => post("bootstrap/totp", { code }),
                  (value) =>
                    setRecoveryCodes(
                      (value as { recoveryCodes: string[] }).recoveryCodes,
                    ),
                );
              }}
            >
              <label>
                Authenticator setup URI
                <input
                  readOnly
                  value={auth.pendingTotpUri}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <label>
                Six-digit code
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
              </label>
              <button className="button primary" disabled={busy}>
                Confirm code
              </button>
            </form>
            <button
              className="button soft"
              disabled={busy}
              onClick={() =>
                void run(
                  () => post("bootstrap/restart", {}),
                  () => {
                    setCode("");
                    setBootstrapToken("");
                  },
                )
              }
            >
              Start setup again
            </button>
          </>
        )}
        {auth && !auth.ownerExists && !auth.pendingTotpUri && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                post("bootstrap/password", {
                  bootstrapToken,
                  displayName: name,
                  password,
                }),
              );
            }}
          >
            <label>
              One-time setup token
              <input
                type="password"
                value={bootstrapToken}
                onChange={(event) => setBootstrapToken(event.target.value)}
                required
              />
            </label>
            <label>
              Your name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={128}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button className="button primary" disabled={busy}>
              Create password login
            </button>
            <button
              className="button soft"
              type="button"
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    const options = await post("bootstrap/passkey/options", {
                      bootstrapToken,
                      displayName: name,
                    });
                    await status();
                    const response = await startRegistration({
                      optionsJSON: options,
                    });
                    return post("bootstrap/passkey/verify", {
                      response,
                      displayName: name,
                    });
                  },
                  (value) =>
                    setRecoveryCodes(
                      (value as { recoveryCodes: string[] }).recoveryCodes,
                    ),
                )
              }
            >
              Create passkey login
            </button>
          </form>
        )}
        {auth?.ownerExists && !auth.pendingTotpUri && (
          <>
            {forgotPassword ? (
              <div className="auth-passkey-recovery">
                <p>
                  To reset a forgotten password, enter an unused recovery code
                  and a current authenticator code. If both factors are lost,
                  this login cannot be recovered.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() =>
                      post("recovery/password", { recoveryCode, code }),
                    );
                  }}
                >
                  <label>
                    Recovery code
                    <input
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Authenticator code
                    <input
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      required
                    />
                  </label>
                  <button className="button primary" disabled={busy}>
                    Reset forgotten password
                  </button>
                </form>
                <button
                  className="button soft"
                  onClick={() => setForgotPassword(false)}
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() =>
                      post(
                        useRecovery ? "login/recovery" : "login/password",
                        useRecovery
                          ? { password, recoveryCode }
                          : { password, code },
                      ),
                    );
                  }}
                >
                  <label>
                    Password
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                    />
                  </label>
                  {useRecovery ? (
                    <label>
                      Recovery code
                      <input
                        value={recoveryCode}
                        onChange={(event) =>
                          setRecoveryCode(event.target.value)
                        }
                        required
                      />
                    </label>
                  ) : (
                    <label>
                      Authenticator code
                      <input
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        maxLength={6}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        required
                      />
                    </label>
                  )}
                  <button className="button primary" disabled={busy}>
                    Sign in
                  </button>
                </form>
                <div className="auth-alternatives">
                  <button
                    className="button soft"
                    disabled={busy}
                    onClick={() => setUseRecovery(!useRecovery)}
                  >
                    {useRecovery ? "Use authenticator" : "Use a recovery code"}
                  </button>
                  <button
                    className="button soft"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const options = await post("login/passkey/options", {});
                        await status();
                        const response = await startAuthentication({
                          optionsJSON: options,
                        });
                        return post("login/passkey/verify", { response });
                      })
                    }
                  >
                    Use passkey
                  </button>
                </div>
                <div className="auth-passkey-recovery">
                  <label>
                    Lost your passkey? Enter a recovery code
                    <input
                      value={recoveryCode}
                      onChange={(event) => setRecoveryCode(event.target.value)}
                    />
                  </label>
                  <button
                    className="button soft"
                    disabled={busy || recoveryCode.length < 16}
                    onClick={() =>
                      void run(
                        async () => {
                          const options = await post(
                            "recovery/passkey/options",
                            {
                              recoveryCode,
                            },
                          );
                          await status();
                          const response = await startRegistration({
                            optionsJSON: options,
                          });
                          return post("recovery/passkey/verify", { response });
                        },
                        (value) =>
                          setRecoveryCodes(
                            (value as { recoveryCodes: string[] })
                              .recoveryCodes,
                          ),
                      )
                    }
                  >
                    Replace passkey
                  </button>
                </div>
                <button
                  className="button soft"
                  onClick={() => setForgotPassword(true)}
                >
                  Forgot password?
                </button>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
export async function logout() {
  try {
    await post("logout", {});
  } catch {
    /* A stale CSRF token cannot prevent leaving the shell. */
  }
  window.location.reload();
}
