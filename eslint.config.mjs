import { baseConfig, webExtras } from '@hair-lab/eslint-config';

export default [...baseConfig, { files: ['apps/web/**/*.{ts,tsx}'], ...webExtras }];
