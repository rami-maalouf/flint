import js from '@eslint/js';
import parser from '@typescript-eslint/parser';
import ts from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', '.artifacts/**'] },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  {
    files: ['**/*.ts'], languageOptions: { parser }, plugins: { '@typescript-eslint': ts },
    rules: { ...ts.configs.recommended.rules, 'no-undef': 'off', 'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
];
