import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`\n🚀 CONROY backend running on http://localhost:${env.PORT}`);
  console.log(`   Health:  http://localhost:${env.PORT}/health`);
  console.log(`   API:     http://localhost:${env.PORT}/api/products\n`);
});
