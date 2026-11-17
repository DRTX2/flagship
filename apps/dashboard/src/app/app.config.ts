import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { authGuard, authInterceptor } from './api';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideRouter(
      [
        { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.Login) },
        { path: '', canActivate: [authGuard], loadComponent: () => import('./pages/flags').then((m) => m.Flags) },
        { path: 'flags/:key', canActivate: [authGuard], loadComponent: () => import('./pages/flag-detail').then((m) => m.FlagDetailPage) },
        { path: 'environments', canActivate: [authGuard], loadComponent: () => import('./pages/environments').then((m) => m.Environments) },
        { path: '**', redirectTo: '' },
      ],
      withComponentInputBinding(),
    ),
  ],
};
