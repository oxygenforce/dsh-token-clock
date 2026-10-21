/**
 * dsh-token-clock — 宿主半边（空逻辑）
 *
 * 这个插件的全部界面都在客户端半边（`lib/client.js`）。宿主条目存在的唯一理由，
 * 是让本包成为 cordis 树上的一行：只有宿主 Loader 里有这个条目，
 * 客户端模块加载器才会把 `lib/client.js` 编进 Web 产物。
 *
 * 纪律：apply() 绝不抛错；不声明任何宿主服务（声明未被 provide 的服务会拖住插件树）。
 */

const PACKAGE_ID = "dsh-token-clock";

export function apply(ctx) {
  try {
    const logger = ctx?.logger;
    const sink = typeof logger === "function" ? logger(PACKAGE_ID) : logger;
    if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] 客户端半边已就绪`);
  } catch {
    /* 日志失败不影响启动 */
  }
}

export default { apply };
