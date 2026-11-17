import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

// Mirrors @flagship/core types (kept local so the dashboard bundle has no Node deps).
export type Value = boolean | string | number | null | Record<string, unknown> | unknown[];
export const OPS = ['in', 'contains', 'startsWith', 'endsWith', 'lt', 'lte', 'gt', 'gte', 'semverGte', 'semverLt'] as const;
export type Op = (typeof OPS)[number];
export interface Clause { attribute: string; op: Op; values: (string | number)[]; negate?: boolean }
export type Serve = { variation: number } | { rollout: { variation: number; weight: number }[]; bucketBy?: string };
export interface Rule { id: string; description?: string; clauses: Clause[]; serve: Serve }
export interface EnvConfig { enabled: boolean; offVariation: number; fallthrough: Serve; rules: Rule[]; version: number; updatedAt: string }
export interface Flag {
  key: string; name: string; description: string | null; kind: 'boolean' | 'string' | 'number' | 'json';
  variations: Value[]; createdAt: string;
}
export interface FlagRow extends Flag { enabled: boolean; offVariation: number; version: number; ruleCount: number; fallthrough: Serve; updatedAt: string }
export interface FlagDetail extends Flag { envs: Record<string, EnvConfig> }
export interface Environment { key: string; name: string; sdkKeyHint: string | null }
export interface AuditEntry { id: number; env: string | null; actor: string; action: string; before: unknown; after: unknown; createdAt: string }
export interface Evaluation { value: Value; variationIndex: number | null; reason: { kind: string; ruleIndex?: number; ruleId?: string; error?: string }; bucket?: number }

/** Session-scoped credentials: closing the tab logs you out. */
@Injectable({ providedIn: 'root' })
export class Auth {
  readonly token = signal(sessionStorage.getItem('fs_token') ?? '');
  readonly actor = signal(sessionStorage.getItem('fs_actor') ?? '');

  login(token: string, actor: string) {
    sessionStorage.setItem('fs_token', token);
    sessionStorage.setItem('fs_actor', actor);
    this.token.set(token);
    this.actor.set(actor);
  }

  logout() {
    sessionStorage.clear();
    this.token.set('');
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  return next(req.clone({ setHeaders: { authorization: `Bearer ${auth.token()}`, 'x-actor': auth.actor() } }));
};

export const authGuard: CanActivateFn = () => (inject(Auth).token() ? true : inject(Router).parseUrl('/login'));

export function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    const m = e.error?.message;
    return Array.isArray(m) ? m.join(' · ') : m ?? e.message;
  }
  return String(e);
}

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  createFlag(body: Pick<Flag, 'key' | 'name' | 'kind' | 'variations'> & { description?: string }) {
    return firstValueFrom(this.http.post<{ key: string }>('/api/flags', body));
  }
  saveConfig(key: string, env: string, cfg: Omit<EnvConfig, 'updatedAt'>) {
    return firstValueFrom(this.http.put<{ version: number }>(`/api/flags/${key}/envs/${env}`, cfg));
  }
  archive(key: string) {
    return firstValueFrom(this.http.delete<void>(`/api/flags/${key}`));
  }
  explain(key: string, env: string, context: Record<string, unknown>) {
    return firstValueFrom(this.http.post<Evaluation>(`/api/flags/${key}/envs/${env}/explain`, { context }));
  }
  rotateKey(env: string) {
    return firstValueFrom(this.http.post<{ sdkKey: string }>(`/api/environments/${env}/sdk-key`, {}));
  }
}

/** Selected environment, shared by every page and remembered per tab. */
@Injectable({ providedIn: 'root' })
export class CurrentEnv {
  readonly key = signal(sessionStorage.getItem('fs_env') ?? 'production');
  set(env: string) {
    sessionStorage.setItem('fs_env', env);
    this.key.set(env);
  }
}
