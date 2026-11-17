import { httpResource } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Auth, CurrentEnv, type Environment } from './api';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (auth.token()) {
      <header class="topbar">
        <a routerLink="/" class="brand"><span class="mark" aria-hidden="true">⚑</span> flagship</a>
        <nav>
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Flags</a>
          <a routerLink="/environments" routerLinkActive="active">Environments</a>
        </nav>
        <label class="env-picker">
          <span class="sr-only">Environment</span>
          <select (change)="env.set($any($event.target).value)">
            @for (e of envs.value() ?? []; track e.key) {
              <option [value]="e.key" [selected]="e.key === env.key()">{{ e.name }}</option>
            }
          </select>
        </label>
        <span class="who">{{ auth.actor() }}</span>
        <button class="btn ghost small" (click)="logout()">Sign out</button>
      </header>
    }
    <main class="page"><router-outlet /></main>
  `,
})
export class App {
  protected auth = inject(Auth);
  protected env = inject(CurrentEnv);
  private router = inject(Router);
  protected envs = httpResource<Environment[]>(() => (this.auth.token() ? '/api/environments' : undefined));

  logout() {
    this.auth.logout();
    this.router.navigateByUrl('/login');
  }
}
