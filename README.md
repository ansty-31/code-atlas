# Code Atlas

> 基于 [kolulu23/Zedema 的 Zombie Atlas](https://github.com/kolulu23/Zedema/tree/5356122cffc3689716fcfc83c6a3aab2b475017a/zombie-atlas) 改造。
> 原作者为 kolulu23（kolulu）及 Zedema 贡献者；ansty-31 于 2026-10-29 扩展多语言支持。
> 按 [GPL v3](LICENSE) 开源，保留上游历史。详见 [署名与改动声明](NOTICE.md)、[更新记录](CHANGELOG.md) 和 [第三方许可](THIRD_PARTY_NOTICES.md)。

面向整个代码仓库的本地代码架构地图。一个工程可同时包含 Python、C、C++ 和 Java；按文件自动选择语法，沿工程目录展示文件、类型和顶层函数。

项目由原来的 Project Zomboid Java 可视化工具改造而来。首批重点是 Python 与 C++，保留 Java 兼容；Lua、PowerShell 尚未接入。

## 启动

需要 Node.js 24 与 npm。

```sh
npm install --ignore-scripts
npm run dev -- --src /path/to/project
```

开发地址默认为 [localhost:5183](http://localhost:5183)。只读取被分析的工程，不导入/执行 Python，也不编译或运行 C/C++。

生产构建与启动：

```sh
npm run build -- --src /path/to/project
npm run serve -- --src /path/to/project
```

服务地址默认为 [localhost:5184](http://localhost:5184)。构建和服务必须指向同一份源码。也可以在本项目的 `.env` 中保存路径：

```dotenv
ATLAS_SRC=/path/to/project
ATLAS_LANGUAGES=auto
```

## 混合语言工程

默认扫描所有已支持的语言，无需选定一种工程语言。

| 语言 | 文件 | 当前结构分析 |
| --- | --- | --- |
| Python | `.py`、`.pyw`、`.pyi` | 模块、类、嵌套类、顶层函数、方法、部分变量、类型注解、直接可解析的继承与导入 |
| C++ | `.cpp`、`.cc`、`.cxx`、`.c++`、`.hpp`、`.hh`、`.hxx`、`.h` | 文件、类/结构体/枚举、命名空间限定名称、函数声明/定义、成员、直接继承与 include |
| C | `.c` 与判定为 C 的 `.h` | 文件、具名结构体/枚举、函数、变量、include |
| Java | `.java` | 原有类型、成员、继承、类型依赖与成员引用分析 |

`.h` 默认随工程内容选择：工程中有 C++ 实现/专用头文件时按 C++ 解析，否则按 C 解析。复杂仓库中的逐文件编译语言判定仍需后续编译数据库支持。

- 默认矩形图沿目录组织，再展开文件与内部实体；不把所有源码都当作 Java 类。
- “源代码语言”筛选主要控制矩形图与继承根；其他统计视图仍展示整个工程。
- “着色依据 → 源代码语言”显示工程内不同语言的分布。
- 选择文件或类型后查看成员、源位置与依赖；源码查看器按实体语言自动加载高亮语法。
- 总览显示各语言的分析能力和存在语法诊断的文件数量。
- Git 仓库中遵循 `.gitignore`，并跳过常见依赖、虚拟环境和构建产物；非 Git 目录只使用内置目录排除规则。

可显式限制扫描语言：

```sh
npm run build -- --src /path/to/project --languages python,cpp
node tools/extract.mjs --src /path/to/project --out /tmp/code-atlas-data
```

## 视图

- **矩形图**：按代码量等指标浏览目录、文件、类型和成员，支持缩放、筛选与语言着色。
- **继承**：仅展示类型及其直接可解析的继承关系；文件模块不冒充类。
- **依赖**：目录/包级图和实体依赖列表。Python 来源是静态 import，C/C++ 来源包括 include 和成员类型引用。
- **子系统**：按目录/包分组的工程概览，不宣称目录名称就是已理解的业务语义。
- **洞察**：代码量、函数复杂度、依赖等静态指标。

## 分析边界

Tree-sitter 的语法结构不等于编译器或运行时语义。当前 Python/C/C++ 不提供精确调用图，不展开 C/C++ 宏，不精确解析重载、模板实例化、动态导入、猴子补丁或函数指针。无法唯一确定的类型关系不连边；外部库源码未被扫描时不生成内部目标。

C++ 的声明与定义保留为不同源位置记录，尚未跨文件合并。Python 实例属性和嵌套函数还未完整建模。include 搜索采用相对路径、工程根与唯一后缀匹配，不等价于实际编译器搜索路径。

混合语言共用一张工程地图，但不会仅凭同名连接 Python 与 C++ 调用。pybind11、ctypes、C ABI 等跨语言关系需要后续证据适配器。

新语言的行数与字节数使用排他归属，避免文件模块与内部类型重复计数。Java 为兼容保留旧统计口径；混合数据的总指标不应直接视为编译器统计。

## 配置与兼容

| 配置 | 含义 |
| --- | --- |
| `--src` / `ATLAS_SRC` | 工程源码根目录 |
| `--languages` / `ATLAS_LANGUAGES` | `auto` 或逗号分隔的 `python,c,cpp,java` |
| `--out` / `ATLAS_DATA_OUT` | 提取数据输出位置，默认 `dist/data` |
| `--pretty` | 格式化 JSON |
| `--no-refs` | 跳过 Java 细粒度引用分析 |
| `--skip-data` | 构建界面时复用已有数据 |

旧的 `ZOMBIE_SRC`、`ZOMBIE_DATA_OUT` 继续支持；无显式路径时保留旧 `zombie/` 默认查找方式。内部 `classes.json`、`ClassRec`、`window.zombieAtlas` 与存储键暂时保留兼容名称；它们不代表只支持类或 Java。

生产静态目录为 `dist/`；源码查看还需服务 `/src/<mount>/...`。自定义数据输出可用于独立提取与开发服务；生产服务仍读取 `dist/data`，部署前应将所选数据放入该目录。

## 验证

```sh
npm run typecheck
npm run test:unit
# 使用仓库自带的小型混合工程执行完整通用检查
npm test
# 对真实工程：先构建要验证的工程，再用同一个 ATLAS_SRC 运行浏览器验证
ATLAS_SRC=/path/to/project node tools/test/runner.mjs --spec multilingual
```

浏览器测试需要 Playwright Chromium：`npx playwright install chromium`。新多语言测试不依赖某个游戏项目；历史浏览器测试中的部分断言仍专门针对原 Java 数据集，保留在 `npm run test:browser:legacy`。

## 架构与后续适配

[多语言架构设计](docs/multilanguage-architecture.md) 说明当前模块边界、统一模型、能力差异，以及后续接入语言和深层语义分析的路径。

[真实工程验证记录](docs/multilanguage-validation.md) 记录 AUV、STM32 与 C++ 用例的结果。[历史 Java 版本说明](docs/java-atlas-legacy.md) 保留原实现细节。
