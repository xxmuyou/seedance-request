import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, normalizeProvider } from './config.ts';
import type { ProviderName } from './config.ts';
import { runPrompt, fetchSeedanceTask } from './core.ts';

type CliOptions = {
  provider?: ProviderName;
  dryRun: boolean;
  images?: string[];
  folder?: boolean;
  at?: string;
  fetchTaskId?: string;
  prompt: string;
};

type ParsedLine = {
  provider: ProviderName;
  prompt: string;
  images?: string[];
  folder?: boolean;
  at?: string;
  switchProvider: boolean;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const options = parseArgs(process.argv.slice(2), config.defaultProvider);

  if (options.fetchTaskId) {
    try {
      const result = await fetchSeedanceTask(config, options.fetchTaskId);
      console.log(`seedance fetch done -> ${result.savedTo}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  if (options.prompt) {
    const resolvedImages = await resolveImages(config.rootDir, options.images, options.folder);
    const ok = await runOnce(
      config,
      options.provider ?? config.defaultProvider,
      options.prompt,
      options.dryRun,
      resolvedImages,
      options.at
    );
    if (!ok) process.exit(1);
    return;
  }

  await startRepl(config, options.provider ?? config.defaultProvider, options.dryRun);
}

function parseArgs(args: string[], defaultProvider: ProviderName): CliOptions {
  let provider: ProviderName | undefined;
  let dryRun = false;
  const images: string[] = [];
  let folder = false;
  let at: string | undefined;
  let fetchTaskId: string | undefined;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      printHelp(defaultProvider);
      process.exit(0);
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--provider') {
      provider = normalizeProvider(args[index + 1] || '') ?? provider;
      index += 1;
      continue;
    }

    if (arg === '--image') {
      if (args[index + 1]) images.push(args[++index]);
      continue;
    }

    if (arg === '--folder') {
      folder = true;
      continue;
    }

    if (arg === '--at' || arg === '--add') {
      at = args[index + 1] || at;
      index += 1;
      continue;
    }

    if (arg === '--fetch') {
      if (args[index + 1]) fetchTaskId = args[++index];
      continue;
    }

    positional.push(arg);
  }

  const first = positional[0];
  if (!provider) {
    provider = normalizeAlias(first) ?? undefined;
    if (provider) positional.shift();
  }

  return {
    provider,
    dryRun,
    images: images.length > 0 ? images : undefined,
    folder: folder || undefined,
    at,
    fetchTaskId,
    prompt: positional.join(' ').trim()
  };
}

async function startRepl(
  config: ReturnType<typeof loadConfig>,
  initialProvider: ProviderName,
  initialDryRun: boolean
): Promise<void> {
  let provider = initialProvider;
  let dryRun = initialDryRun;
  const rl = createInterface({ input, output });

  console.log(`seed-local ready · provider=${provider} · dryRun=${dryRun ? 'on' : 'off'}`);
  console.log('输入 prompt 直接生成，/seedream / /seedance / /seed3d 切换模型，/help 查看帮助，/exit 退出。');

  try {
    while (true) {
      const line = (await rl.question(`${provider}> `)).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;

      if (line === '/help') {
        printHelp(config.defaultProvider);
        continue;
      }

      if (line.startsWith('/dry')) {
        const val = line.slice('/dry'.length).trim();
        dryRun = val === 'on' || (val !== 'off' && !dryRun);
        console.log(`dryRun => ${dryRun ? 'on' : 'off'}`);
        continue;
      }

      const parsed = parsePromptLine(line, provider);

      if (parsed.switchProvider) {
        provider = parsed.provider;
        console.log(`provider => ${provider}`);
      }

      if (parsed.prompt || (parsed.images && parsed.images.length > 0) || parsed.folder) {
        const resolvedImages = await resolveImages(config.rootDir, parsed.images, parsed.folder);
        await runOnce(config, parsed.provider, parsed.prompt, dryRun, resolvedImages, parsed.at);
      }
    }
  } finally {
    rl.close();
  }
}

function parsePromptLine(line: string, fallbackProvider: ProviderName): ParsedLine {
  let rest = line;
  let provider = fallbackProvider;
  let switchProvider = false;

  if (rest === '/seedream' || rest.startsWith('/seedream ')) {
    provider = 'seedream';
    switchProvider = true;
    rest = rest.slice('/seedream'.length).trim();
  } else if (rest === '/seedance' || rest.startsWith('/seedance ')) {
    provider = 'seedance';
    switchProvider = true;
    rest = rest.slice('/seedance'.length).trim();
  } else if (rest === '/seed3d' || rest.startsWith('/seed3d ')) {
    provider = 'seed3d';
    switchProvider = true;
    rest = rest.slice('/seed3d'.length).trim();
  }

  const { prompt, images, folder, at } = parseInlineFlags(rest);
  return { provider, prompt, images, folder, at, switchProvider };
}

function parseInlineFlags(text: string): { prompt: string; images?: string[]; folder?: boolean; at?: string } {
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const images: string[] = [];
  let folder = false;
  let at: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '--image' && tokens[i + 1]) {
      images.push(stripTokenQuotes(tokens[++i]));
    } else if (tokens[i] === '--folder') {
      folder = true;
    } else if ((tokens[i] === '--at' || tokens[i] === '--add') && tokens[i + 1]) {
      at = stripTokenQuotes(tokens[++i]);
    } else {
      rest.push(tokens[i]);
    }
  }

  return { prompt: rest.join(' ').trim(), images: images.length > 0 ? images : undefined, folder: folder || undefined, at };
}

function stripTokenQuotes(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

async function runOnce(
  config: ReturnType<typeof loadConfig>,
  provider: ProviderName,
  prompt: string,
  dryRun: boolean,
  images?: string[],
  at?: string
): Promise<boolean> {
  try {
    const result = await runPrompt(config, provider, prompt, dryRun, { images, at });

    if (dryRun) {
      console.log(JSON.stringify(result.request, null, 2));
      return true;
    }

    console.log(`${result.provider} done -> ${result.savedTo}`);
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

function normalizeAlias(value?: string): ProviderName | null {
  if (!value) return null;
  if (value === 'image') return 'seedream';
  if (value === 'video') return 'seedance';
  if (value === '3d') return 'seed3d';
  return normalizeProvider(value);
}

const SOURCE_FOLDER = join('assets', 'source');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);

async function resolveImages(rootDir: string, images?: string[], folder?: boolean): Promise<string[] | undefined> {
  if (!folder) return images;

  const sourceDir = join(rootDir, SOURCE_FOLDER);
  let folderFiles: string[];
  try {
    const entries = await readdir(sourceDir);
    folderFiles = entries
      .filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
      .sort()
      .map((f) => join(SOURCE_FOLDER, f));
  } catch {
    throw new Error(`找不到 ${SOURCE_FOLDER} 目录，请先创建该目录并放入图片。`);
  }

  if (folderFiles.length === 0) {
    throw new Error(`${SOURCE_FOLDER} 目录下没有找到任何图片文件。`);
  }

  const merged = [...folderFiles, ...(images ?? [])];
  return merged;
}

function printHelp(defaultProvider: ProviderName): void {
  console.log(`
seed-local

用法:
  seed-local [seedream|seedance|seed3d] [--image <path>] ... [--folder] [--at|--add <path>] [--dry-run] "your prompt"
  seed-local --provider seedream|seedance|seed3d [--image <path>] ... [--folder] [--at|--add <path>] "your prompt"
  seed-local                              # 进入交互模式

选项:
  --fetch <task_id>  直接通过任务 ID 查询并下载 seedance 视频（用于补救已完成任务）
  --image <path>    将本地图片作为参考图加入请求（可重复使用多次传入多张图）
                    seedream / seedance 支持多图；seed3d 只使用第一张
  --folder          将 assets/source/ 目录下所有图片加入请求（可与 --image 同时使用）
  --at <path>       将本地文本文件内容追加到 prompt
  --add <path>      同 --at，将本地文本文件内容追加到 prompt
  --dry-run         只打印请求体，不发送请求
  --provider        指定 provider（seedream / seedance / seed3d）

示例:
  npm exec -- seed-local seedance --fetch cgt-20260319165026-vphvg
  npm exec -- seed-local "一只在月球上骑车的猫"
  npm exec -- seed-local seedance "赛博朋克城市航拍镜头"
  npm exec -- seed-local seedance --image ./assets/ref.png "女孩抱着狐狸，镜头缓缓拉出"
  npm exec -- seed-local seedance --image ./assets/a.png --image ./assets/b.png "两图融合风格"
  npm exec -- seed-local seedance --folder "将所有参考图融合生成视频"
  npm exec -- seed-local seedream --folder --image ./assets/extra.png "参考图生成"
  npm exec -- seed-local seed3d --image ./assets/object.png
  npm exec -- seed-local seed3d --image ./assets/object.png --add ./context.txt
  npm exec -- seed-local --at ./context.txt "根据上述内容生成图片"
  npm exec -- seed-local --dry-run "只打印请求体"

交互模式命令:
  /seedream [prompt]          切换到 seedream 模型（可选附带 prompt 直接生成）
  /seedance [prompt]          切换到 seedance 模型（可选附带 prompt 直接生成）
  /seed3d [--image <path>]    切换到 seed3d 模型（可选附带 --image 直接生成）
  <prompt> [--image <path>] [--image <path>] [--folder] [--at|--add <path>]   直接生成
  /dry [on|off]               切换 dry-run 模式
  /help                       显示帮助
  /exit                       退出

当前默认 provider: ${defaultProvider}
配置文件: ./.env
输出目录: ./assets
source 图片目录: ./assets/source
`.trim());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
