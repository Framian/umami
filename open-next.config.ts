import { defineCloudflareConfig } from '@opennextjs/cloudflare/config';

const config = defineCloudflareConfig({});
config.buildCommand = 'pnpm build:worker:prep';

export default config;
