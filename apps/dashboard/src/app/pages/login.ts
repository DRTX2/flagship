import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Auth } from '../api';

@Component({
  selector: 'app-login',
  template: `
    <form class="login card" (submit)="submit($event, name.value, token.value)">
      <h1><span class="mark">⚑</span> flagship</h1>
      <p class="muted">Feature flags with local evaluation and real-time rollout.</p>
      <label>Your name <span class="muted">(recorded in the audit log)</span><input #name required autocomplete="name" /></label>
      <label>Admin token<input #token type="password" required autocomplete="current-password" /></label>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <button class="btn primary" [disabled]="busy()">{{ busy() ? 'Checking…' : 'Sign in' }}</button>
    </form>
  `,
})
export class Login {
  private auth = inject(Auth);
  private http = inject(HttpClient);
  private router = inject(Router);
  protected error = signal('');
  protected busy = signal(false);

  async submit(e: Event, name: string, token: string) {
    e.preventDefault();
    this.busy.set(true);
    this.auth.login(token, name.trim());
    try {
      await firstValueFrom(this.http.get('/api/environments')); // validates the token
      this.router.navigateByUrl('/');
    } catch {
      this.auth.logout();
      this.error.set('Invalid admin token');
    } finally {
      this.busy.set(false);
    }
  }
}
