import { readFile, writeFile } from 'node:fs/promises';
import { compileProfiles, assertCompiledProfilesCurrent } from '../src/mvp/config.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.error('Uso: node scripts/compile-profiles.mjs [--check]');
  process.exitCode = 1;
} else {
  try {
    const source = new URL('../config/profiles.yaml', import.meta.url);
    const output = new URL('../config/profiles.generated.json', import.meta.url);
    const rawText = await readFile(source, 'utf8');
    const expected = JSON.stringify(compileProfiles(rawText), null, 2) + '\n';
    if (args[0] === '--check') {
      let actual;
      try { actual = JSON.parse(await readFile(output, 'utf8')); }
      catch { throw new Error('PROFILE_COMPILED_STALE'); }
      assertCompiledProfilesCurrent(rawText, actual);
      console.log('Perfis YAML válidos; JSON gerado atualizado.');
    } else {
      await writeFile(output, expected);
      console.log('Perfis YAML validados e compilados para JSON.');
    }
  } catch (error) {
    // Errors contain fixed codes/paths only, never YAML values or credentials.
    console.error(error?.message === 'PROFILE_COMPILED_STALE'
      ? 'PROFILE_COMPILED_STALE: executar npm run profiles:compile e incluir o JSON gerado.'
      : /^PROFILE_(?:CONFIG_INVALID|YAML_INVALID)/.test(error?.message ?? '') ? error.message : 'PROFILE_COMPILE_FAILED');
    process.exitCode = 1;
  }
}
