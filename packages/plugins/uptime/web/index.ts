import { defineWebPlugin } from '@rxf/web-sdk';
import { trustCertificate } from './trust.ts';

export default defineWebPlugin({
  id: 'uptime',
  widgets: {
    checks: {
      title: { de: 'Uptime-Prüfungen', en: 'Uptime checks' },
      sizes: ['M', 'L'],
      component: () => import('./widgets/checks.tsx'),
    },
  },
  onboarding: {
    configForm: () => import('./config-form.tsx'),
    trustCertificate,
  },
});
