import { httpResource } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Api, errorMessage, type Environment } from '../api';

@Component({
  selector: 'app-environments',
  template: `
    <div class="page-head"><h1>Environments</h1></div>
    <p class="muted">Each environment has its own targeting and its own server-side SDK key. Keys are stored hashed: a new key is shown once, and rotating revokes the old one immediately.</p>
    <div class="card list">
      @for (e of envs.value() ?? []; track e.key) {
        <div class="flag-row static">
          <span class="flag-main"><strong>{{ e.name }}</strong><code>{{ e.key }}</code></span>
          <span class="muted mono">{{ e.sdkKeyHint ? 'fs_sdk_…' + e.sdkKeyHint : 'no key yet' }}</span>
          <button class="btn small" (click)="rotate(e.key)">{{ e.sdkKeyHint ? 'Rotate key' : 'Generate key' }}</button>
        </div>
        @if (revealed()?.env === e.key) {
          <div class="reveal">
            <p><b>Copy this key now.</b> It will not be shown again.</p>
            <code class="mono">{{ revealed()!.key }}</code>
            <button class="btn small" (click)="copy(revealed()!.key)">{{ copied() ? 'Copied' : 'Copy' }}</button>
          </div>
        }
      }
    </div>
    @if (error()) { <p class="error">{{ error() }}</p> }

    <section class="card">
      <header class="card-head"><h2>Use it</h2></header>
      <pre class="code">{{ snippet }}</pre>
    </section>
  `,
})
export class Environments {
  private api = inject(Api);
  protected envs = httpResource<Environment[]>(() => '/api/environments');
  protected revealed = signal<{ env: string; key: string } | null>(null);
  protected copied = signal(false);
  protected error = signal('');
  protected snippet = `import { FlagshipClient } from '@flagship/sdk';

const flags = await FlagshipClient.init({ sdkKey: process.env.FLAGSHIP_SDK_KEY, baseUrl: 'https://flags.example.com' });

// local, synchronous, ~1µs: no network call per evaluation
if (flags.variation('new-checkout', { key: user.id, country: user.country }, false)) {
  renderNewCheckout();
}`;

  async rotate(env: string) {
    const hadKey = this.envs.value()?.find((e) => e.key === env)?.sdkKeyHint;
    if (hadKey && !confirm(`Rotate the ${env} SDK key? Services using the current key will stop receiving updates.`)) return;
    try {
      const { sdkKey } = await this.api.rotateKey(env);
      this.revealed.set({ env, key: sdkKey });
      this.copied.set(false);
      this.envs.reload();
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  async copy(text: string) {
    await navigator.clipboard.writeText(text);
    this.copied.set(true);
  }
}
