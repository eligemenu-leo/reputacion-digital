// Empaqueta API y worker para producción. Los paquetes del monorepo (@rep/*,
// publicados como TypeScript) se incluyen en el bundle; el resto de
// dependencias se resuelven desde node_modules en tiempo de ejecución.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/server.ts', 'src/worker.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'externalize-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@rep/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
