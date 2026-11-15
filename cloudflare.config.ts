import { bindings, defineConfig } from 'cf/config';
import { loadDeployment } from './config/deployment.ts';

export default defineConfig(({ mode }) => {
  const deployment = loadDeployment(mode);
  const local = mode === 'development';
  return {
    accountId: deployment.accountId,
    worker: {
      name: deployment.workerName,
      compatibilityDate: '2026-11-15',
      entrypoint: 'src/index.ts',
      workersDev: false,
      previewUrls: false,
      domains: local ? [] : [deployment.hostname],
      assets: { runWorkerFirst: true },
      env: {
        AUTH_ISSUER: bindings.text(deployment.accessIssuer),
        AUTH_AUDIENCE: bindings.text(deployment.accessAudience),
        DEV_AUTH: bindings.text(local ? 'true' : 'false'),
        DB: bindings.d1({ name: deployment.databaseName, id: deployment.databaseId }),
        FILES: bindings.r2({ name: deployment.bucketName }),
        ASSETS: bindings.assets(),
      },
    },
  };
});
