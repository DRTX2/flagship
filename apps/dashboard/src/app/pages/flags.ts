import { httpResource } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api, CurrentEnv, errorMessage, type Flag, type FlagRow, type Serve, type Value } from '../api';

const DEFAULT_VARIATIONS: Record<Flag['kind'], string> = {
  boolean: 'false\ntrue',
  string: '"control"\n"treatment"',
  number: '10\n20',
  json: '{"limit": 10}\n{"limit": 50}',
};

@Component({
  selector: 'app-flags',
  imports: [RouterLink, DatePipe],
  template: `
    <div class="page-head">
      <h1>Feature flags <span class="env-badge" [class.prod]="env.key() === 'production'">{{ env.key() }}</span></h1>
      <input class="search" type="search" placeholder="Filter flags…" aria-label="Filter flags" (input)="query.set($any($event.target).value)" />
      <button class="btn primary" (click)="creating.set(!creating())">{{ creating() ? 'Cancel' : 'New flag' }}</button>
    </div>

    @if (creating()) {
      <form class="card create" (submit)="create($event)">
        <div class="grid-3">
          <label>Key<input name="key" required pattern="[a-z0-9][a-z0-9._\\-]{0,63}" placeholder="new-checkout" /></label>
          <label>Name<input name="name" required placeholder="New checkout flow" /></label>
          <label>Type
            <select name="kind" (change)="kind.set($any($event.target).value)">
              <option value="boolean">Boolean</option><option value="string">String</option>
              <option value="number">Number</option><option value="json">JSON</option>
            </select>
          </label>
        </div>
        <label>Description<input name="description" /></label>
        <label>Variations <span class="muted">(one JSON value per line, immutable once created)</span>
          <textarea name="variations" rows="3" class="mono" [value]="defaults()"></textarea>
        </label>
        @if (createError()) { <p class="error" role="alert">{{ createError() }}</p> }
        <button class="btn primary">Create flag</button>
      </form>
    }

    @if (flags.isLoading() && !flags.hasValue()) {
      <div class="card skeleton" aria-busy="true"></div>
    } @else if (flags.error()) {
      <p class="error">Could not load flags.</p>
    } @else if (!filtered().length) {
      <div class="card empty">No flags yet. Create one to start shipping safely.</div>
    } @else {
      <div class="card list">
        @for (f of filtered(); track f.key) {
          <a class="flag-row" [routerLink]="['/flags', f.key]">
            <span class="status-dot" [class.on]="f.enabled" [attr.aria-label]="f.enabled ? 'on' : 'off'"></span>
            <span class="flag-main">
              <strong>{{ f.name }}</strong>
              <code>{{ f.key }}</code>
            </span>
            <span class="flag-serving">{{ serving(f) }}</span>
            <span class="chip">{{ f.kind }}</span>
            @if (f.ruleCount) { <span class="chip">{{ f.ruleCount }} rule{{ f.ruleCount > 1 ? 's' : '' }}</span> }
            <span class="muted small">v{{ f.version }} · {{ f.updatedAt | date: 'MMM d, HH:mm' }}</span>
          </a>
        }
      </div>
    }
  `,
})
export class Flags {
  private api = inject(Api);
  private router = inject(Router);
  protected env = inject(CurrentEnv);
  protected flags = httpResource<FlagRow[]>(() => `/api/flags?env=${this.env.key()}`);
  protected query = signal('');
  protected creating = signal(false);
  protected createError = signal('');
  protected kind = signal<Flag['kind']>('boolean');
  protected defaults = computed(() => DEFAULT_VARIATIONS[this.kind()]);
  protected filtered = computed(() => {
    const q = this.query().toLowerCase();
    return (this.flags.value() ?? []).filter((f) => !q || f.key.includes(q) || f.name.toLowerCase().includes(q));
  });

  serving(f: FlagRow): string {
    if (!f.enabled) return `off → ${this.show(f.variations[f.offVariation])}`;
    const s: Serve = f.fallthrough;
    if ('variation' in s) return `serving ${this.show(f.variations[s.variation])}`;
    return s.rollout.map((r) => `${r.weight / 1000}% ${this.show(f.variations[r.variation])}`).join(' / ');
  }

  private show(v: Value): string {
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  async create(e: Event) {
    e.preventDefault();
    const data = new FormData(e.target as HTMLFormElement);
    let variations: Value[];
    try {
      variations = String(data.get('variations')).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      this.createError.set('Each variation line must be valid JSON (strings need quotes)');
      return;
    }
    try {
      const { key } = await this.api.createFlag({
        key: String(data.get('key')), name: String(data.get('name')),
        description: String(data.get('description') || '') || undefined, kind: this.kind(), variations,
      });
      this.router.navigate(['/flags', key]);
    } catch (err) {
      this.createError.set(errorMessage(err));
    }
  }
}
