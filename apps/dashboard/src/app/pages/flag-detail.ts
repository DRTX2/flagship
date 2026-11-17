import { httpResource } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  Api, CurrentEnv, errorMessage, OPS, type AuditEntry, type Clause, type EnvConfig, type Evaluation,
  type FlagDetail, type Op, type Serve, type Value,
} from '../api';

type Draft = Omit<EnvConfig, 'updatedAt'>;
const NUMERIC_OPS: Op[] = ['lt', 'lte', 'gt', 'gte'];
const OP_LABELS: Record<Op, string> = {
  in: 'is one of', contains: 'contains', startsWith: 'starts with', endsWith: 'ends with',
  lt: '<', lte: '≤', gt: '>', gte: '≥', semverGte: 'version ≥', semverLt: 'version <',
};
const clone = <T,>(v: T): T => structuredClone(v);

@Component({
  selector: 'app-flag-detail',
  imports: [RouterLink, DatePipe],
  template: `
    <a routerLink="/" class="muted back">← All flags</a>
    @if (flag.value(); as f) {
      <div class="page-head">
        <div>
          <h1>{{ f.name }}</h1>
          <code class="muted">{{ f.key }}</code>
          @if (f.description) { <p class="muted">{{ f.description }}</p> }
        </div>
        <button class="btn danger ghost" (click)="archive(f.key)">Archive</button>
      </div>

      @if (draft(); as d) {
        <section class="card toggle-card" [class.on]="d.enabled">
          <button class="switch" role="switch" [attr.aria-checked]="d.enabled" (click)="patch((x) => (x.enabled = !x.enabled))">
            <span class="knob"></span>
          </button>
          <div>
            <strong>{{ d.enabled ? 'On' : 'Off' }} in <span class="env-badge" [class.prod]="env.key() === 'production'">{{ env.key() }}</span></strong>
            <p class="muted small">
              @if (d.enabled) { Targeting rules below decide what each user gets. }
              @else { Everyone gets <b>{{ show(f.variations[d.offVariation]) }}</b>. Rules are ignored. }
            </p>
          </div>
          <label class="inline">When off, serve
            <select (change)="patch((x) => (x.offVariation = +$any($event.target).value))">
              @for (v of f.variations; track $index) { <option [value]="$index" [selected]="$index === d.offVariation">{{ show(v) }}</option> }
            </select>
          </label>
        </section>

        <section class="card">
          <header class="card-head"><h2>Targeting rules</h2><span class="muted small">evaluated top to bottom, first match wins</span></header>
          @for (rule of d.rules; track rule.id; let ri = $index) {
            <div class="rule">
              <div class="rule-head">
                <span class="rule-n">{{ ri + 1 }}</span>
                <input class="rule-desc" placeholder="Rule description" [value]="rule.description ?? ''"
                       (change)="patch((x) => (x.rules[ri].description = $any($event.target).value || undefined))" />
                <button class="btn ghost small" [disabled]="ri === 0" (click)="moveRule(ri, -1)" aria-label="Move up">↑</button>
                <button class="btn ghost small" [disabled]="ri === d.rules.length - 1" (click)="moveRule(ri, 1)" aria-label="Move down">↓</button>
                <button class="btn ghost small danger" (click)="patch((x) => x.rules.splice(ri, 1))">Remove</button>
              </div>
              @for (c of rule.clauses; track $index; let ci = $index) {
                <div class="clause">
                  <span class="muted">{{ ci === 0 ? 'If' : 'and' }}</span>
                  <input class="attr" placeholder="attribute" [value]="c.attribute" (change)="setClause(ri, ci, { attribute: $any($event.target).value })" />
                  <select (change)="setClause(ri, ci, { negate: $any($event.target).value === 'not' })">
                    <option value="" [selected]="!c.negate">✓</option><option value="not" [selected]="c.negate">not</option>
                  </select>
                  <select (change)="setOp(ri, ci, $any($event.target).value)">
                    @for (op of ops; track op) { <option [value]="op" [selected]="op === c.op">{{ opLabel[op] }}</option> }
                  </select>
                  <input class="vals" placeholder="values, comma-separated" [value]="c.values.join(', ')"
                         (change)="setValues(ri, ci, $any($event.target).value)" />
                  <button class="btn ghost small" [disabled]="rule.clauses.length === 1" (click)="patch((x) => x.rules[ri].clauses.splice(ci, 1))" aria-label="Remove condition">✕</button>
                </div>
              }
              <button class="btn ghost small" (click)="patch((x) => x.rules[ri].clauses.push(newClause()))">+ condition</button>
              <div class="serve-row">
                <span class="muted">serve</span>
                <select (change)="setServe('rule', ri, $any($event.target).value)">
                  @for (v of f.variations; track $index) { <option [value]="$index" [selected]="isVariation(rule.serve, $index)">{{ show(v) }}</option> }
                  <option value="rollout" [selected]="isRollout(rule.serve)">percentage rollout</option>
                </select>
              </div>
              @if (rollout(rule.serve); as r) {
                <div class="rollout">
                  @for (w of r.rollout; track $index; let wi = $index) {
                    <label class="pct">{{ show(f.variations[w.variation]) }}
                      <input type="number" min="0" max="100" step="0.1" [value]="w.weight / 1000"
                             (change)="setWeight('rule', ri, wi, $any($event.target).value)" />%
                    </label>
                  }
                  <span class="sum" [class.bad]="sum(r) !== 100000">= {{ sum(r) / 1000 }}%</span>
                </div>
              }
            </div>
          } @empty {
            <p class="muted">No rules. Everyone gets the default below.</p>
          }
          <button class="btn small" (click)="addRule()">+ Add rule</button>
        </section>

        <section class="card">
          <header class="card-head"><h2>Default rule</h2><span class="muted small">for users no rule matched</span></header>
          <div class="serve-row">
            <span class="muted">serve</span>
            <select (change)="setServe('fallthrough', 0, $any($event.target).value)">
              @for (v of f.variations; track $index) { <option [value]="$index" [selected]="isVariation(d.fallthrough, $index)">{{ show(v) }}</option> }
              <option value="rollout" [selected]="isRollout(d.fallthrough)">percentage rollout</option>
            </select>
          </div>
          @if (rollout(d.fallthrough); as r) {
            <div class="rollout">
              @for (w of r.rollout; track $index; let wi = $index) {
                <label class="pct">{{ show(f.variations[w.variation]) }}
                  <input type="number" min="0" max="100" step="0.1" [value]="w.weight / 1000"
                         (change)="setWeight('fallthrough', 0, wi, $any($event.target).value)" />%
                </label>
              }
              <span class="sum" [class.bad]="sum(r) !== 100000">= {{ sum(r) / 1000 }}%</span>
              <div class="bar" aria-hidden="true">
                @for (w of r.rollout; track $index) { <span [style.flex]="w.weight" [attr.data-i]="w.variation % 4"></span> }
              </div>
            </div>
          }
        </section>

        <div class="savebar" [class.visible]="dirty()">
          <span>Unsaved changes to <b>{{ env.key() }}</b></span>
          @if (saveError()) { <span class="error">{{ saveError() }}</span> }
          <button class="btn ghost" (click)="reset()">Discard</button>
          <button class="btn primary" [disabled]="saving()" (click)="save(f.key)">{{ saving() ? 'Saving…' : 'Save changes' }}</button>
        </div>
      }

      <div class="grid-2">
        <section class="card">
          <header class="card-head"><h2>Why does a user get this?</h2></header>
          <p class="muted small">Runs the same engine as the SDKs against the saved config.</p>
          <textarea #ctx rows="5" class="mono" [value]="sampleContext"></textarea>
          <button class="btn small" (click)="explain(f.key, ctx.value)">Evaluate</button>
          @if (evaluation(); as ev) {
            <div class="explain">
              <div><span class="muted">value</span> <b class="mono">{{ show(ev.value) }}</b></div>
              <div><span class="muted">reason</span> {{ reasonText(ev) }}</div>
              @if (ev.bucket !== undefined) { <div><span class="muted">bucket</span> {{ (ev.bucket / 1000).toFixed(3) }}%</div> }
            </div>
          }
          @if (explainError()) { <p class="error">{{ explainError() }}</p> }
        </section>

        <section class="card">
          <header class="card-head"><h2>History</h2></header>
          <ol class="audit">
            @for (a of audit.value() ?? []; track a.id) {
              <li><b>{{ a.actor }}</b> {{ a.action }} @if (a.env) { in <span class="env-badge small" [class.prod]="a.env === 'production'">{{ a.env }}</span> }
                <span class="muted small">{{ a.createdAt | date: 'MMM d, HH:mm:ss' }}</span>
                @if (a.before && a.env === env.key()) {
                  <button class="btn ghost small restore" (click)="restore(f.key, a)" title="Restore the configuration from before this change">Restore</button>
                }
              </li>
            } @empty { <li class="muted">No changes yet.</li> }
          </ol>
        </section>
      </div>
    } @else if (flag.error()) {
      <p class="error">Flag not found.</p>
    }
  `,
})
export class FlagDetailPage {
  readonly key = input.required<string>();
  private api = inject(Api);
  private router = inject(Router);
  protected env = inject(CurrentEnv);
  protected flag = httpResource<FlagDetail>(() => `/api/flags/${this.key()}`);
  protected audit = httpResource<AuditEntry[]>(() => `/api/flags/${this.key()}/audit`);

  protected ops = OPS;
  protected opLabel = OP_LABELS;
  protected sampleContext = JSON.stringify({ key: 'user-123', email: 'ana@acme.com', country: 'EC', plan: 'pro', appVersion: '2.4.1' }, null, 2);

  private saved = computed<Draft | undefined>(() => {
    const cfg = this.flag.value()?.envs[this.env.key()];
    if (!cfg) return undefined;
    const { updatedAt: _, ...rest } = cfg;
    return rest;
  });
  protected draft = signal<Draft | undefined>(undefined);
  protected dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.saved()));
  protected saving = signal(false);
  protected saveError = signal('');
  protected evaluation = signal<Evaluation | undefined>(undefined);
  protected explainError = signal('');

  constructor() {
    // Reloading the flag or switching environment resets the editor to the saved config.
    effect(() => {
      const s = this.saved();
      this.draft.set(s ? clone(s) : undefined);
      this.saveError.set('');
    });
  }

  // ---- draft mutation helpers: every edit goes through patch() so signals see a new object
  patch(fn: (d: Draft) => unknown) {
    const next = clone(this.draft()!);
    fn(next);
    this.draft.set(next);
  }
  newClause(): Clause { return { attribute: 'country', op: 'in', values: [] }; }
  addRule() {
    this.patch((d) => d.rules.push({ id: crypto.randomUUID().slice(0, 8), clauses: [this.newClause()], serve: { variation: Math.min(1, this.flag.value()!.variations.length - 1) } }));
  }
  moveRule(i: number, dir: number) {
    this.patch((d) => { const [r] = d.rules.splice(i, 1); d.rules.splice(i + dir, 0, r); });
  }
  setClause(ri: number, ci: number, part: Partial<Clause>) {
    this.patch((d) => Object.assign(d.rules[ri].clauses[ci], part));
  }
  setOp(ri: number, ci: number, op: Op) {
    this.patch((d) => {
      const c = d.rules[ri].clauses[ci];
      c.op = op;
      c.values = c.values.map((v) => (NUMERIC_OPS.includes(op) ? Number(v) : String(v)));
    });
  }
  setValues(ri: number, ci: number, raw: string) {
    this.patch((d) => {
      const c = d.rules[ri].clauses[ci];
      const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
      c.values = NUMERIC_OPS.includes(c.op) ? parts.map(Number).filter((n) => !Number.isNaN(n)) : parts;
    });
  }
  setServe(where: 'rule' | 'fallthrough', ri: number, mode: string) {
    const n = this.flag.value()!.variations.length;
    // Even split; the first variation absorbs the remainder so weights always sum to exactly 100%.
    const s: Serve = mode === 'rollout'
      ? { rollout: Array.from({ length: n }, (_, i) => ({ variation: i, weight: Math.floor(100_000 / n) + (i === 0 ? 100_000 % n : 0) })) }
      : { variation: +mode };
    this.patch((d) => (where === 'rule' ? (d.rules[ri].serve = s) : (d.fallthrough = s)));
  }
  setWeight(where: 'rule' | 'fallthrough', ri: number, wi: number, pct: string) {
    const weight = Math.round(Math.max(0, Math.min(100, Number(pct) || 0)) * 1000);
    this.patch((d) => {
      const s = where === 'rule' ? d.rules[ri].serve : d.fallthrough;
      if ('rollout' in s) s.rollout[wi].weight = weight;
    });
  }

  isVariation(s: Serve, i: number) { return 'variation' in s && s.variation === i; }
  isRollout(s: Serve) { return 'rollout' in s; }
  rollout(s: Serve) { return 'rollout' in s ? s : null; }
  sum(r: { rollout: { weight: number }[] }) { return r.rollout.reduce((a, w) => a + w.weight, 0); }
  show(v: Value | undefined): string { return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v); }
  reasonText(ev: Evaluation): string {
    switch (ev.reason.kind) {
      case 'OFF': return 'flag is off';
      case 'FALLTHROUGH': return ev.bucket !== undefined ? 'default rule (percentage rollout)' : 'default rule';
      case 'RULE_MATCH': {
        const rule = this.saved()?.rules[ev.reason.ruleIndex!];
        return `matched rule ${ev.reason.ruleIndex! + 1}${rule?.description ? ` "${rule.description}"` : ''}`;
      }
      default: return ev.reason.error ?? ev.reason.kind;
    }
  }

  reset() { this.draft.set(clone(this.saved()!)); this.saveError.set(''); }

  async save(key: string) {
    this.saving.set(true);
    this.saveError.set('');
    try {
      await this.api.saveConfig(key, this.env.key(), this.draft()!);
      this.flag.reload();
      this.audit.reload();
    } catch (e) {
      this.saveError.set(errorMessage(e));
    } finally {
      this.saving.set(false);
    }
  }

  async explain(key: string, raw: string) {
    this.explainError.set('');
    this.evaluation.set(undefined);
    try {
      this.evaluation.set(await this.api.explain(key, this.env.key(), JSON.parse(raw)));
    } catch (e) {
      this.explainError.set(e instanceof SyntaxError ? 'Context must be valid JSON' : errorMessage(e));
    }
  }

  async restore(key: string, entry: AuditEntry) {
    if (!confirm(`Restore ${key} in ${this.env.key()} to how it was before "${entry.action}" by ${entry.actor}?`)) return;
    try {
      await this.api.rollback(key, this.env.key(), entry.id);
      this.flag.reload();
      this.audit.reload();
    } catch (e) {
      this.saveError.set(errorMessage(e));
    }
  }

  async archive(key: string) {
    if (!confirm(`Archive "${key}"? SDKs will stop receiving it and fall back to their default value.`)) return;
    await this.api.archive(key);
    this.router.navigateByUrl('/');
  }
}
