# Changelog

## [24.0.12](https://github.com/ax-llm/ax/compare/24.0.10...24.0.11) (2026-08-28)

### Bug Fixes

* **gemini:** send the thinking config the port never built ([#620](https://github.com/ax-llm/ax/issues/620)) ([08d396d](https://github.com/ax-llm/ax/commit/08d396d9d290122a35d75a976cfba79514b9b49e))
* **java:** allow slower Maven Central publishes ([#619](https://github.com/ax-llm/ax/issues/619)) ([671dceb](https://github.com/ax-llm/ax/commit/671dceb740bc9bf0bf55513b790fa48d93fe4a28))

## [24.0.11](https://github.com/ax-llm/ax/compare/24.0.10...24.0.11) (2026-08-27)

### Features

* **axir:** add portable runtime hooks ([#617](https://github.com/ax-llm/ax/issues/617)) ([33ff4a0](https://github.com/ax-llm/ax/commit/33ff4a0639d44cd5979002ba52d880eb8029ad99))

### Bug Fixes

* **deepseek:** preserve medium reasoning effort ([#616](https://github.com/ax-llm/ax/issues/616)) ([5f478be](https://github.com/ax-llm/ax/commit/5f478bef38e78b9296ed0ea94733417ed1a7827a))
* **go:** surface HTTP errors from embed, transcribe and speak ([#615](https://github.com/ax-llm/ax/issues/615)) ([c4851c8](https://github.com/ax-llm/ax/commit/c4851c898e71321aea7b4b4d45c628439dcdb62e))
* **release:** publish merged releases automatically ([#614](https://github.com/ax-llm/ax/issues/614)) ([9879cc1](https://github.com/ax-llm/ax/commit/9879cc13123eb1248144ca21f894631de4fd774d))

## [24.0.11](https://github.com/ax-llm/ax/compare/24.0.9...24.0.10) (2026-08-27)

### Features

* **axir:** add portable runtime hooks ([#617](https://github.com/ax-llm/ax/issues/617)) ([33ff4a0](https://github.com/ax-llm/ax/commit/33ff4a0639d44cd5979002ba52d880eb8029ad99))

### Bug Fixes

* **deepseek:** preserve medium reasoning effort ([#616](https://github.com/ax-llm/ax/issues/616)) ([5f478be](https://github.com/ax-llm/ax/commit/5f478bef38e78b9296ed0ea94733417ed1a7827a))
* **go:** surface HTTP errors from embed, transcribe and speak ([#615](https://github.com/ax-llm/ax/issues/615)) ([c4851c8](https://github.com/ax-llm/ax/commit/c4851c898e71321aea7b4b4d45c628439dcdb62e))
* **release:** publish merged releases automatically ([#614](https://github.com/ax-llm/ax/issues/614)) ([9879cc1](https://github.com/ax-llm/ax/commit/9879cc13123eb1248144ca21f894631de4fd774d))

## [24.0.10](https://github.com/ax-llm/ax/compare/24.0.9...24.0.10) (2026-08-27)

### Features

* **gemini:** support inference service tiers ([#609](https://github.com/ax-llm/ax/issues/609)) ([f7e2dfe](https://github.com/ax-llm/ax/commit/f7e2dfe4cda665b16b9675f7c78fe4f4b4b8197b))

### Bug Fixes

* **axai:** forward the requested embedding size to Gemini ([#612](https://github.com/ax-llm/ax/issues/612)) ([6e2cfb2](https://github.com/ax-llm/ax/commit/6e2cfb2de1ca122e5edd0c8dcc111e0e793398d4))

## [24.0.10](https://github.com/ax-llm/ax/compare/24.0.7...24.0.8) (2026-08-27)

### Features

* **gemini:** support inference service tiers ([#609](https://github.com/ax-llm/ax/issues/609)) ([f7e2dfe](https://github.com/ax-llm/ax/commit/f7e2dfe4cda665b16b9675f7c78fe4f4b4b8197b))

### Bug Fixes

* **axai:** forward the requested embedding size to Gemini ([#612](https://github.com/ax-llm/ax/issues/612)) ([6e2cfb2](https://github.com/ax-llm/ax/commit/6e2cfb2de1ca122e5edd0c8dcc111e0e793398d4))
* **go:** let hosts read the AxError envelope through errors.As ([#610](https://github.com/ax-llm/ax/issues/610)) ([7b4e478](https://github.com/ax-llm/ax/commit/7b4e478b4e81e90bcd589566cf5ea34b7778df32))

## [24.0.8](https://github.com/ax-llm/ax/compare/24.0.7...24.0.8) (2026-08-25)

### Bug Fixes

* **go/goja:** truncate an oversized log line instead of deleting it ([#604](https://github.com/ax-llm/ax/issues/604)) ([736ae2b](https://github.com/ax-llm/ax/commit/736ae2b9f1a3d14572a357133294b046635aff72)), closes [#602](https://github.com/ax-llm/ax/issues/602) [#602](https://github.com/ax-llm/ax/issues/602)

## [24.0.9](https://github.com/ax-llm/ax/compare/24.0.7...24.0.8) (2026-08-27)

### Bug Fixes

* **go:** let hosts read the AxError envelope through errors.As ([#610](https://github.com/ax-llm/ax/issues/610)) ([7b4e478](https://github.com/ax-llm/ax/commit/7b4e478b4e81e90bcd589566cf5ea34b7778df32))

## [24.0.8](https://github.com/ax-llm/ax/compare/24.0.7...24.0.8) (2026-08-25)

### Bug Fixes

* **go/goja:** truncate an oversized log line instead of deleting it ([#604](https://github.com/ax-llm/ax/issues/604)) ([736ae2b](https://github.com/ax-llm/ax/commit/736ae2b9f1a3d14572a357133294b046635aff72)), closes [#602](https://github.com/ax-llm/ax/issues/602) [#602](https://github.com/ax-llm/ax/issues/602)

## 24.0.9 (2026-08-26)

### ⚠ BREAKING CHANGES

* remove flow.fromMermaid/toMermaid — flow(text) and toString() are the API
* rename AxJSInterpreter API to AxJSRuntime
* **gepa:** compile now throws if `options.maxMetricCalls` is absent or non-positive.

* fix(gepa): only skip reflective after an evaluated merge attempt\n\nAlign single-module merge gating with the reference engine so reflective mutation is skipped only when a merge is actually attempted, improving behavioral parity and avoiding lost reflective iterations when no valid merge pair exists.

* docs(optimize): migrate multi-objective docs to GEPA/GEPA-Flow using compile (remove compilePareto)

### Features

* accept mermaid text in flow() and render flows via toString() ([f83bbf7](https://github.com/24601/halligan/commit/f83bbf72e91b75faa45befcc6f1a3e619776c1fc))
* **ace:** implement agentic context engineering ([#386](https://github.com/24601/halligan/issues/386)) ([a54eb50](https://github.com/24601/halligan/commit/a54eb50b9069eae5e00d02c683cdce459e7d596c))
* add agentStatusCallback and fix final() contract in AxAgent RLM ([921357f](https://github.com/24601/halligan/commit/921357f5c15c3a30693a5d5555989af7663c1888))
* Add ai parameter to wrapFunction and related methods in AxAgent for enhanced functionality ([0e59c96](https://github.com/24601/halligan/commit/0e59c9636b30e4060df710936fd3c73f44ca5b9d))
* add AI SDK v7 support ([#557](https://github.com/24601/halligan/issues/557)) ([ec940f8](https://github.com/24601/halligan/commit/ec940f80b792f9e302b1319ed6215d8294ff5f4d))
* add anthropic claude llms ([1e09f67](https://github.com/24601/halligan/commit/1e09f6720f34aa8025a37410df45c0cdedcfec49))
* add api rate-limiter support ([e4a8863](https://github.com/24601/halligan/commit/e4a8863e8fbbe3b7123737493bbb5c786eb51d96))
* add AWS Bedrock provider integration ([#395](https://github.com/24601/halligan/issues/395)) ([6ce7eb3](https://github.com/24601/halligan/commit/6ce7eb3219c9936bec0916ca0572be9fe17c670c))
* add AxAgent RLM support, self-tuning improvements, and docs updates ([508ba77](https://github.com/24601/halligan/commit/508ba7775a742bfda20a59c4cdd8f0a30f14ea07))
* add AxChatResponse missing fields analysis and enhance type definitions ([23d72a3](https://github.com/24601/halligan/commit/23d72a3c062a45b9d7ba61f422b77d7eac16ba30))
* add AxGen multi-sampling parity ([#582](https://github.com/24601/halligan/issues/582)) ([4483dd8](https://github.com/24601/halligan/commit/4483dd85ca2eff4f6f3c34f423c2b0ef3500e752))
* add azure openai ([4478ed1](https://github.com/24601/halligan/commit/4478ed12c23abba3e935e84d37550a401f4562fb))
* add built-in function for embeddings ([37dfa99](https://github.com/24601/halligan/commit/37dfa99cb67eb36fabce79273727a3f201a3aa0b))
* add busines information extraction prompt ([cb2dca5](https://github.com/24601/halligan/commit/cb2dca5b34ffda2c0d03b45ac4c2c9d240615cc1))
* add caching proxy ([ba57bf9](https://github.com/24601/halligan/commit/ba57bf9417a74b719daa795afcd501235da1d3af))
* add caching proxy ([335dcbd](https://github.com/24601/halligan/commit/335dcbdbc4311784d095cc6be66b57d2a0d5909c))
* add CellOutputSelector component and integrate with NotebookCell ([2c4b70f](https://github.com/24601/halligan/commit/2c4b70f899e1605fc8751cedc6478c0cfa71a694))
* add comprehensive API and Quick Start documentation ([4fbbf45](https://github.com/24601/halligan/commit/4fbbf452c5e0736ceb5a598d2d46a97c36eee7f1))
* add comprehensive AxFlow guide and enhance documentation ([2acf9c8](https://github.com/24601/halligan/commit/2acf9c82871391b964d824e6548a59e6d9b4d3cd))
* add comprehensive cursor rules documentation for Ax framework ([d7e1c17](https://github.com/24601/halligan/commit/d7e1c17f121d9f1efff79bf9545c1faa1336f084))
* add comprehensive documentation for AI providers, DSPy signatures, and AxFlow ([09c324a](https://github.com/24601/halligan/commit/09c324a26d91c87fed66ae5910a4b2e265028e64))
* add comprehensive migration guide for Ax v14.0.0+ API changes ([9a5a706](https://github.com/24601/halligan/commit/9a5a7060a48f9eef46efc680b0cdf6b42bff5df2))
* add comprehensive tests for AxFlowDependencyAnalyzer and AxFlowExecutionPlanner ([db090b2](https://github.com/24601/halligan/commit/db090b28ff39b12c2a5bec7f434d90c3289798f4))
* Add configurable comparator for AxBalance service order ([#81](https://github.com/24601/halligan/issues/81)) ([9f9864b](https://github.com/24601/halligan/commit/9f9864b0796df1ff5fe5c0d7a8400ad100b8d7d4))
* add configurable thinking token budget levels for Google Gemini ([fc30ce4](https://github.com/24601/halligan/commit/fc30ce48174385e612afd4019e83976a77d51434))
* Add conversational memory weaving example to README ([b0ca31d](https://github.com/24601/halligan/commit/b0ca31dcbee044ed2d705890e7ce95959e3a284e))
* Add date and datetime field types and clarify dual syntax for format validators across documentation. ([f1abcab](https://github.com/24601/halligan/commit/f1abcabcb3797f3975146bce5890b1c5bf6bb774))
* add debug logging functionality to NotebookCell ([821e363](https://github.com/24601/halligan/commit/821e3636fd473fb1bb666f5a5bbbed9b486729f6))
* Add DeepWiki links to navigation component ([48c0194](https://github.com/24601/halligan/commit/48c01944ec54fc2e2e5f62cc738d4ab34cdace83))
* add derive method for field transformation with batch processing ([e2f223a](https://github.com/24601/halligan/commit/e2f223a15ba82865f909cecd7269d1ae527c9c00))
* Add disclaimer to system prompt and separator to user query to clarify few-shot examples and demonstrations. ([b2a4ee1](https://github.com/24601/halligan/commit/b2a4ee17037809a4102ed2c44493813be75310f9))
* add documentation for AWS Bedrock, Vercel AI SDK, and Ax Tools packages. ([95962ae](https://github.com/24601/halligan/commit/95962aea36ec9be84a2eb726ca8200985aaaaf84))
* add evidence-aware ACE playbooks ([af000ee](https://github.com/24601/halligan/commit/af000eee2407919898613b4e8f3cd9398cf57261))
* add experimental program-source optimization ([ca943d6](https://github.com/24601/halligan/commit/ca943d6a55e9ff332306c253567700635e1ab420))
* Add explicit context caching for AI models and refactor structured output example rendering in prompts. ([afe40c2](https://github.com/24601/halligan/commit/afe40c2119b07be40482eeb5d203baaa86e1590f))
* add field processing functions to output fields ([fb996da](https://github.com/24601/halligan/commit/fb996da34ee714c0bb906e4943feedf87ae8717f))
* add function result formatter support ([0382a93](https://github.com/24601/halligan/commit/0382a933e299db529e2fc7496c04365aa34babe4))
* add function-call fallback for structured output on unsupported providers ([f3e787c](https://github.com/24601/halligan/commit/f3e787c8997ed588a3bb3bb5eb2146149cc8a266))
* Add Gemini 3 Flash Preview model and update food search example to use it. ([f08335f](https://github.com/24601/halligan/commit/f08335fd48f483413beb620b1ac11988f2c1b5d6))
* add GEPA multi-objective optimization example and enhance documentation ([f64189c](https://github.com/24601/halligan/commit/f64189c45844ae7149f0d35a4aa7f7b792ba0a5d))
* add google gemini safety controls ([7783bbe](https://github.com/24601/halligan/commit/7783bbee545d13a7b9f8a899d64ec2e59d1c931f))
* add google palm models ([cf6bf11](https://github.com/24601/halligan/commit/cf6bf11e30dee95d0799e6d19baa573a2a9765b9))
* add gpt-4 support ([405b87e](https://github.com/24601/halligan/commit/405b87e60fbb5942646e013c3a56fbc13d120c24))
* add GPT-4.1 nano model support ([#387](https://github.com/24601/halligan/issues/387)) ([0aa4aa2](https://github.com/24601/halligan/commit/0aa4aa2ceed1ba61106711baed6ce962cf2eb604))
* Add GPT-5 model definitions and update documentation to use strongly typed AI model enums. ([3ff2546](https://github.com/24601/halligan/commit/3ff2546cda3049d3c285865fae14ab74a331004e))
* add GPT-5.4 models + fix: pass chatReqUpdater through Azure OpenAI ([#505](https://github.com/24601/halligan/issues/505)) ([6cef135](https://github.com/24601/halligan/commit/6cef135884d671ac18f67d754748ca34bdf9501c))
* add Grok live search example for real-time web queries ([c29cef0](https://github.com/24601/halligan/commit/c29cef030159d77c2e4dcd2d0e00f879d86d3f1a))
* add host-owned authority boundary ([0927f99](https://github.com/24601/halligan/commit/0927f99d4f06a301163d29cb111e86167a6d3774))
* Add initPackage script for creating new packages in the Ax monorepo ([08746e8](https://github.com/24601/halligan/commit/08746e86f33b1b8eee3f978fe5031e8e3c8206fe))
* add input audio type compatibility ([#78](https://github.com/24601/halligan/issues/78)) ([23189d4](https://github.com/24601/halligan/commit/23189d443de85fc7045d560223181aad9e1e528c))
* add inputUpdateCallback for dynamic input updates during actor turns ([b233e2f](https://github.com/24601/halligan/commit/b233e2f408fb8c52f7c884f933a92f250ddd4c82))
* add local field support to keep shared fields available in parent agents ([e84014b](https://github.com/24601/halligan/commit/e84014b41bba5879d7dea0371974b193062484c1))
* Add maxTokens field to AxModelInfo and update Anthropic model configurations ([f2645e6](https://github.com/24601/halligan/commit/f2645e684091b03d9740fa5c58641c3ef0047153))
* add MCP catalog subscriptions and event runtime ([669d22f](https://github.com/24601/halligan/commit/669d22f50fd683c057a77584b7e2a361635fce2a))
* add MiPro optimization with Python service integration ([b1fe6e3](https://github.com/24601/halligan/commit/b1fe6e373b000765d31bc6cb1f421d3dcfc2a962))
* Add Model Context Protocol (MCP) integration to README ([484f2e8](https://github.com/24601/halligan/commit/484f2e8a127ed417a697a49e11a614c96e480914))
* add multi format build with CJS build for compatibility ([#40](https://github.com/24601/halligan/issues/40)) ([2e3c8d8](https://github.com/24601/halligan/commit/2e3c8d8835626de7083fe2e97d015fa031cbaea5))
* add multilingual Ax Academy ([1535efa](https://github.com/24601/halligan/commit/1535efa4fd2b30e7d129cf1ab5126b95f2f7727b))
* add named AI deployment profiles ([dec44b8](https://github.com/24601/halligan/commit/dec44b8fdd4a8e8deb776de0d441385d974e1f27))
* add native structured ReAct module ([0c03834](https://github.com/24601/halligan/commit/0c03834d19ec0bce695bc4d5a1310370ee4984f4))
* add ollama ([c1181e0](https://github.com/24601/halligan/commit/c1181e02e775f218a928dfdd0013d306c8e19106))
* add OpenAI web search example and improve JSON schema validation ([b71ecf5](https://github.com/24601/halligan/commit/b71ecf5b4363a5cf84877fc12a6492e2b0e9c352))
* add OpenRouter support and example ([f616c0a](https://github.com/24601/halligan/commit/f616c0acf77c87b7bb795b932e0591ae8b2e9bb4))
* add OrcaRouter named deployment profile ([#584](https://github.com/24601/halligan/issues/584)) ([95e4fab](https://github.com/24601/halligan/commit/95e4fab0c00e62805322989d0993bb9e2269882b))
* add portable structured output and renewable credentials ([1b3b597](https://github.com/24601/halligan/commit/1b3b5979e2a39c391c06f7018dcaef467d58cac8))
* Add Pull Request CI workflow ([38be189](https://github.com/24601/halligan/commit/38be189c492cfb1329154f6e604ae1dddd9a01c1))
* add refusal error handling and logging capabilities ([0a000ac](https://github.com/24601/halligan/commit/0a000ac26470910c976765c0aa56868065b153ea))
* add rehype plugins for enhanced document linking and type-safe AI model inference ([6dafe2a](https://github.com/24601/halligan/commit/6dafe2a91fafa62a78517467d33e285e92f9bbf9))
* add result picker functionality for selecting optimal outputs from multiple samples ([483506a](https://github.com/24601/halligan/commit/483506a1941b8762ee3a12bfbcf2010fea53e8c1))
* add RLM Discovery example with writing coach and analytics tools ([9f5ec0d](https://github.com/24601/halligan/commit/9f5ec0d52dbb7315667997d8c5ec88daffeed02b))
* add RLM support in AxAgent for long context analysis ([41e3254](https://github.com/24601/halligan/commit/41e32544f9af8fc0fed406cb1d5554e171046477))
* add schema cleaning functions for Anthropic and Gemini API compatibility ([040f615](https://github.com/24601/halligan/commit/040f615b7741829c7c36ffb728a9fd1a21c04c95))
* add self-registration prevention for child agents and update documentation references ([74f9c14](https://github.com/24601/halligan/commit/74f9c14d8a8285a529ab21b50edac42f8e80f477))
* add semantic router ([2096158](https://github.com/24601/halligan/commit/209615831a9f814bc10071280857d2b4f51c2a3a))
* Add showThoughts feature to enhance model reasoning visibility ([fabc76d](https://github.com/24601/halligan/commit/fabc76d5ef5b3d745b78f75615d6f43946d130af))
* add signature tool calling for non-native tool support ([#298](https://github.com/24601/halligan/issues/298)) ([29f4cdb](https://github.com/24601/halligan/commit/29f4cdbd200fe4349de7c66531abce6c3b3f24ac))
* add step context, step hooks, and self-tuning with enriched descriptions ([76bddaa](https://github.com/24601/halligan/commit/76bddaad8c89c0fb896e982c1f555d0bee36089f))
* add stop() and success()/failed() to AxAgentCompletionProtocol ([375e391](https://github.com/24601/halligan/commit/375e3916c34e33a1d064a82d8a382dcaec2f87f1))
* add streaming support for gemini and cohere ([a946d52](https://github.com/24601/halligan/commit/a946d521f01267208ca863b0fd52b1f1d91d6929))
* add streaming support to proxy ([5edd33c](https://github.com/24601/halligan/commit/5edd33c1905a00a6fb1f05f395090e569ea954e5))
* add support flags for Google Gemini models ([5e785f0](https://github.com/24601/halligan/commit/5e785f0691c3d9e85adb63ef5e974acca6201d3a))
* add support for Claude 4.5 Opus model ([#467](https://github.com/24601/halligan/issues/467)) ([88c573b](https://github.com/24601/halligan/commit/88c573bf862aa0fdc5036a3acb55124e07f950ef))
* add support for embeddings to use with vector search ([4bd4ba4](https://github.com/24601/halligan/commit/4bd4ba4cb9d3edd1dabea3ec8b3c3201b06b18da))
* add support for file and URL types in Ax framework ([b7e0a78](https://github.com/24601/halligan/commit/b7e0a784234229643a8512b70aaf027cb4877f95))
* add support for json type and other fixes ([3249746](https://github.com/24601/halligan/commit/32497461524b6138bf0c6142f71fe1d5b96386a2))
* add support for new tool types in Anthropic API ([367dad0](https://github.com/24601/halligan/commit/367dad056faae1a8c6a849cd7ff22c765498569a))
* Add support for shared fields and agents in AxAgent, enhancing agent hierarchy data passing ([e541397](https://github.com/24601/halligan/commit/e541397cb54b3cd365364638275a4fb36736a7a5))
* Add support for shared fields in AxAgent and context management ([59d7604](https://github.com/24601/halligan/commit/59d76049c6ed030ac8f87e71aac1fc90ea09db5d))
* add support for structured outputs across various AI models and enhance error handling for complex fields ([816484c](https://github.com/24601/halligan/commit/816484c9a1538c2bba2a9c724c3e8d1266f6b25a))
* Add support for thinking models and enhance AI response handling ([e4489f9](https://github.com/24601/halligan/commit/e4489f9b0b4638b40cbaef6b293c960612d91a93))
* add thinking configuration and enhance Anthropic model support ([5bdb6ed](https://github.com/24601/halligan/commit/5bdb6ed169117e501b11541d47db7c863e3bc491))
* add thoughtBlock to AxChatResponseResult and enhance validation ([7b49f65](https://github.com/24601/halligan/commit/7b49f65bf5474fb1c9e337e76e231c74ad21da98))
* add together compute llm api support ([37fc9cf](https://github.com/24601/halligan/commit/37fc9cf27e0b75e0068e7b58956b784ead6934cf))
* Add toInputJSONSchema method and related tests for AxSignature and agent function parameters ([c836239](https://github.com/24601/halligan/commit/c836239d398687d45e6fd6916be9a99a76edaf0c))
* add validation for chat prompt and AxMessage array ([ab3f3d9](https://github.com/24601/halligan/commit/ab3f3d9beb500af3b20262e7c70caba0a8018844))
* add vector db and embeddings example ([141ad9f](https://github.com/24601/halligan/commit/141ad9f1dd4d4f19c8ef07b362c57cb628f42e37))
* added a ai sdk agent provider ([9f030c0](https://github.com/24601/halligan/commit/9f030c0d99e4dd91090fc25350455d9da1a28bb5))
* added a new llm alephalpha ([bff5f51](https://github.com/24601/halligan/commit/bff5f51812bcf22a8f6c89e58c98866208f14e1a))
* added additional tests for agent ([e463f20](https://github.com/24601/halligan/commit/e463f209103152ea585af06fb4dd974bd22d5124))
* added agent tracing ([4bc9ae7](https://github.com/24601/halligan/commit/4bc9ae7ca5e02f194a23ed73b3aa8dcbbda43e4a))
* added claude3, gemini and fixed openai azure ([1c902d1](https://github.com/24601/halligan/commit/1c902d102fc8bce226c7c29bdafdb6e98b4ce170))
* added datetime field support ([bd05b0e](https://github.com/24601/halligan/commit/bd05b0ef940abc3f279667d87330f368a37cd8d0))
* added dsp ([fc9c292](https://github.com/24601/halligan/commit/fc9c292838fd7cdbb9e36633d7ad847206349c64))
* added email auth ([f8fac72](https://github.com/24601/halligan/commit/f8fac723f25dfd62cece50c4f3ef8cec98b8eb87))
* added fastFail to agents and axgen ([eac6a71](https://github.com/24601/halligan/commit/eac6a71b7e158cef7a6b235a25776926d14f96bd))
* added google search retrieval for gemini ([f659dc6](https://github.com/24601/halligan/commit/f659dc6151f837d4b59cd14ab4ed8525b8c57c0c))
* added in memory vector db with serialize to disk ([5036933](https://github.com/24601/halligan/commit/50369334388332ee9414b80b92835ab3915e786e))
* added mistral support ([67747a0](https://github.com/24601/halligan/commit/67747a0dd0840e429fda5c9c98f36fce125133e5))
* added more tests ([fe33451](https://github.com/24601/halligan/commit/fe33451711c9870144cafa8e242fa05fc3152f09))
* added multi-modal chat to rome ([7e8f8a7](https://github.com/24601/halligan/commit/7e8f8a7e641603ed169fbea48555c04cb8e1c549))
* added multi-modal support to anthropic api and other fixes ([95a0680](https://github.com/24601/halligan/commit/95a0680ec61d8d9803c6cea0b2732abebf046461))
* added new models for mistral and openai ([b0ae470](https://github.com/24601/halligan/commit/b0ae470dd911323aedb977313ec5242a7f80ebec))
* added openai chat-gpt api support ([eb4b151](https://github.com/24601/halligan/commit/eb4b151c160bb33560c2072240e4770572b4f0ff))
* added prefix Ax across type namespace ([3a9daf0](https://github.com/24601/halligan/commit/3a9daf0e45de834fc7b8719c2908f1b90800e0e2))
* added proxy bin ([65adabe](https://github.com/24601/halligan/commit/65adabe6de137a886a3055d6f9ea32f2304635e1))
* added reka models ([ef1f267](https://github.com/24601/halligan/commit/ef1f2677220073253a7c020668842c3635d26924))
* added support for o1 models ([8f06b16](https://github.com/24601/halligan/commit/8f06b162330fed4b5aebd0c8f0bcafb28072d46b))
* added tests for field extraction functions ([4818f09](https://github.com/24601/halligan/commit/4818f09ccc9ea7dd69d7897b8fa3ed9fad3de921))
* added the dsp style bootstrap few stop optimizer ([eab69c8](https://github.com/24601/halligan/commit/eab69c811c510235fe28377c83db662b15489909))
* agent framework, agents can use other agents ([93cbfb3](https://github.com/24601/halligan/commit/93cbfb3912e13e7e353ae70311be4467a2c97568))
* agent framework, agents can use other agents ([a7420e7](https://github.com/24601/halligan/commit/a7420e7256bf12667449c96a35d84c1a0f66d2ef))
* **agent:** add contextOptions to independently bound the ctx distillation stage ([7e77158](https://github.com/24601/halligan/commit/7e7715861d69f7b798d18fbc356635e853a66cc2))
* **agent:** add durable retained child sessions ([625e072](https://github.com/24601/halligan/commit/625e072dcd5e4178d6f726738ffbd5113e635be4))
* **agent:** add playbook retention policy ([e5174ff](https://github.com/24601/halligan/commit/e5174ff8a33503e7c71b9beb1c048c12972c8245))
* **agent:** add preference evidence selection ([2ef9eb7](https://github.com/24601/halligan/commit/2ef9eb796723c3ea6d56f23025e56951a7e63104))
* **agent:** agent.improve() — failure-driven repair with regression-validated acceptance ([994aac0](https://github.com/24601/halligan/commit/994aac0e6a7932eb02d6855f5ba8dbaf651e2f3c))
* **agent:** auto-upgrade smart defaults for discovery and context fields ([c114323](https://github.com/24601/halligan/commit/c1143238765bd7ae85fe17678d7013f23e6f9238))
* **agent:** construction-time playbook with run-end failure learning ([87be227](https://github.com/24601/halligan/commit/87be2273faca24a14e3a4704e42b0477c8dac29c))
* **agent:** direct-respond — distiller respond(task, evidence) skips the executor ([8df3c3c](https://github.com/24601/halligan/commit/8df3c3c2b715c70ec77441453079a089cd3ea547))
* **agent:** direct-respond live eval gate — 0 false-skips, 100% skip recall on both pinned models ([30669f1](https://github.com/24601/halligan/commit/30669f163981dc81928cb8cb16b937c43093b5f0))
* **agent:** drop llmQuery advanced mode, simplify RLM actor prompts ([1f2d8a1](https://github.com/24601/halligan/commit/1f2d8a17142cc341333e9f3ab89eb2584423582f))
* **agent:** gate executable skill artifacts ([8dd7d5d](https://github.com/24601/halligan/commit/8dd7d5d2a038396159c30806f895d25d518f8704))
* **agent:** opt-in chain-of-evidence citations on the responder ([12fe8d0](https://github.com/24601/halligan/commit/12fe8d0b81f256b482dbdc782dffa3879e5f971f))
* **agent:** pass alreadyLoaded snapshot to onMemoriesSearch ([69ae7d2](https://github.com/24601/halligan/commit/69ae7d2308d25013f151796f4dad378fbb65906e))
* **agent:** require held-out playbook promotion ([77b3cba](https://github.com/24601/halligan/commit/77b3cba4ca6300f623d596de26f7d5f60736d76c))
* agents can now have pass through fields in agent swarms ([2e1c021](https://github.com/24601/halligan/commit/2e1c021f330e17227b5340316a27a7aed6cf46df))
* **agent:** shape hints in evidence descriptors and context metadata ([3306475](https://github.com/24601/halligan/commit/3306475085414d36aee4411ad2466e08e53bef8a))
* **agent:** shared runtime session across distiller/executor phases ([2395334](https://github.com/24601/halligan/commit/23953349a02a5f3b43845d69dbba99033919cf75))
* **agent:** Stage 2+3 — split RLM actor templates and coordinator AxAgent ([68cdff3](https://github.com/24601/halligan/commit/68cdff31cad687ffe3907b6e3870fa7968b26792))
* **agent:** unified relevance layer with catalog-backed search and advisory hints ([6840ab3](https://github.com/24601/halligan/commit/6840ab390a69bdb3e0e52a35c72c26b33b994329))
* **agent:** unify child-agent registration through functions array ([689c0ba](https://github.com/24601/halligan/commit/689c0ba98fcf6efd7fef0455227becbaa88faacd))
* ai balancer to pick the cheapest llm with automatic fallback ([a8f7b7b](https://github.com/24601/halligan/commit/a8f7b7b9772691056d94a5cfec4d94f064df4a8f))
* **ai:** add adaptive balancer routing ([0f26c05](https://github.com/24601/halligan/commit/0f26c05ef2201b9c97b981510d89d38d56be4928))
* **ai:** add adaptive visual frame sampler ([4dd1921](https://github.com/24601/halligan/commit/4dd1921cd12d1b6b220f647e79ec38a2daaf7ee2))
* **ai:** add new models, xhigh reasoning effort, and Anthropic structured output fix ([ec008b7](https://github.com/24601/halligan/commit/ec008b772ec12ace026a453a11f5af1e23c6a9ec))
* **ai:** add portable global usage observer ([4ad1a33](https://github.com/24601/halligan/commit/4ad1a3307c988cb4a74dc3ea874255d24368b095))
* Allow all fields to be optional in examples and simplify prompt template validation ([18cd73b](https://github.com/24601/halligan/commit/18cd73b478622516c6bdaac49d8141ae0e1f530e))
* Allow custom field name for thought in AxGen ([#227](https://github.com/24601/halligan/issues/227)) ([924bf1b](https://github.com/24601/halligan/commit/924bf1b7e17d51443d2ceac62a9e3ecfabc7cf9b))
* Allow disabling thought token budget with override ([#229](https://github.com/24601/halligan/issues/229)) ([89e00e4](https://github.com/24601/halligan/commit/89e00e45356f9c0ac784f9398b580030a0b1fb9b))
* **anthropic:** add Claude 4.5 Haiku model and update logging for thought display ([2d84bc2](https://github.com/24601/halligan/commit/2d84bc266d26b3338d68fc24a86e6faaf78288b0))
* **anthropic:** add Claude 4.5 Sonnet model with pricing and token limits ([af101b4](https://github.com/24601/halligan/commit/af101b42593abc668877099fed474421d81de6a5))
* **anthropic:** add Claude Sonnet 5 support ([#558](https://github.com/24601/halligan/issues/558)) ([811dee8](https://github.com/24601/halligan/commit/811dee880ff6a52f6432812f045029ea2fbe9ba0))
* **anthropic:** add validation for arbitrary json objects in structured outputs ([#459](https://github.com/24601/halligan/issues/459)) ([7db81c5](https://github.com/24601/halligan/commit/7db81c5b2222095da0927f9c4882a0b5de0163a7))
* **anthropic:** implement extended thinking signature handling in streaming mode ([c73646f](https://github.com/24601/halligan/commit/c73646f410eebe536edaed4967d84c27bc89261e))
* **anthropic:** update and align Vertex AI model maxTokens values ([#426](https://github.com/24601/halligan/issues/426)) ([f042d7b](https://github.com/24601/halligan/commit/f042d7b6e9b1c5c2b5981a238aef7ea3c61dec5d))
* apicall and sse updates ([74d70b6](https://github.com/24601/halligan/commit/74d70b61de38664dca7ce97ff4619f5f516ae27e))
* **api:** enhance function parameter handling and schema validation across multiple AI integrations ([e593e75](https://github.com/24601/halligan/commit/e593e7521ec231f2e9841babe8cb4dfb13bd2512))
* auto-fix json syntax errors ([dc27812](https://github.com/24601/halligan/commit/dc27812ec9c9521dcc38d526e23191e9466e7d4e))
* automatic long term memory ([e94ffd5](https://github.com/24601/halligan/commit/e94ffd50d910ff6b17c25e7131ee87c38b2eba56))
* automatic model upgrade in axagent ([d841ed6](https://github.com/24601/halligan/commit/d841ed6298d6ce2280f5ed5e568ef0df6a091185))
* automatic vectordb retrieval augmented generation in proxy ([d081c18](https://github.com/24601/halligan/commit/d081c189f4cb78a217f7cfeeb127f528153a8813))
* aws bedrock support ([acdc89b](https://github.com/24601/halligan/commit/acdc89b49c733b6a31bb5e17694c6abe28d324eb))
* ax web first commit ([bccb572](https://github.com/24601/halligan/commit/bccb5722302f0c9746e9f3d3567f97c6fff8de32))
* ax-tools to restore Node.js-specific functionality (AxJSInterpreter & AxMCPStdioTransport) ([#271](https://github.com/24601/halligan/issues/271)) ([d1deab2](https://github.com/24601/halligan/commit/d1deab2a37b8d7c31f60e8ee616b7b0d473dc31c))
* axagent test harness ([413b590](https://github.com/24601/halligan/commit/413b590e6276e9afe60c011a449fdb1c63814356))
* **axir:** add modern MCP semantic foundations ([75ae884](https://github.com/24601/halligan/commit/75ae884cbb268037926dd4a266da30321bbff011))
* **axir:** assert balancer streaming failover + close [#556](https://github.com/24601/halligan/issues/556) transient-error port ([57df89b](https://github.com/24601/halligan/commit/57df89bc62329bb99da941964eef5d1590f7c2d5))
* **axir:** clear portable provider backlog ([486d7fb](https://github.com/24601/halligan/commit/486d7fbe7855be0fd50801d1d12c0acc2240252a))
* **axir:** enforce AxAgent semantic parity ([7d4947a](https://github.com/24601/halligan/commit/7d4947aa1097348dac170a80f73c6bf4601ff65e))
* **axir:** map GPT-5.6 reasoning effort ([f9d6ae3](https://github.com/24601/halligan/commit/f9d6ae3affdc505cf0c0880a8173a057b512c9d2))
* **axir:** port ACE shape guard, playbook attach, citations, stage instruction, verified evolve, anthropic adaptive fixes ([1e1e849](https://github.com/24601/halligan/commit/1e1e849eb2c09f36068f15f885e2f0e66fddf68d))
* **axir:** port actor multi-fence rejection ([e872fbb](https://github.com/24601/halligan/commit/e872fbb994e0c2ed22c2136756420806c959fd8a))
* **axir:** port adaptive balancer routing ([1b74dc0](https://github.com/24601/halligan/commit/1b74dc0c59a5be34fc7f7ed5265c2bf0382146bf))
* **axir:** port agent backlog to generated packages ([d22f09d](https://github.com/24601/halligan/commit/d22f09d5595a221eae9a86fa5e0b76e66e9332c3))
* **axir:** port Anthropic transient-error classification + 529 retryability + streaming-overload retry ([4f4f8c0](https://github.com/24601/halligan/commit/4f4f8c02528466d8215d51bb472d26f0a5140270)), closes [#556](https://github.com/24601/halligan/issues/556)
* **axir:** port direct-respond to AxIR and all five language runtimes ([b86d16d](https://github.com/24601/halligan/commit/b86d16dce93ca4a8afb2d2946b38bcd54e4cf127))
* **axir:** port dual-era MCP client ([e43afb3](https://github.com/24601/halligan/commit/e43afb35854c370a637f13acf416668f263c7efb))
* **axir:** port extended signature grammar ([08d6494](https://github.com/24601/halligan/commit/08d64949a801a03ae531352a29e4406c7d053112))
* **axir:** port flow mermaid dialect ([3e88dbf](https://github.com/24601/halligan/commit/3e88dbf0fd850fe91bdff6d2fbf9df44fc249ef2))
* **axir:** port managed Gemini context caching ([e843410](https://github.com/24601/halligan/commit/e8434104a87b536dad1d19ecd2b036cf24960b27))
* **axir:** port MCP cacheable results ([2067e57](https://github.com/24601/halligan/commit/2067e579c0147530133e59ecc115b3a5c02b6990))
* **axir:** port MCP inbound requests and task input ([09a14ad](https://github.com/24601/halligan/commit/09a14addf945ac4c91abb824113c358f966f2e70))
* **axir:** port MCP OAuth issuer validation ([82272c5](https://github.com/24601/halligan/commit/82272c59c56a083e80f44e941ff1637acd5d10af))
* **axir:** port MCP subscriptions listen ([400092a](https://github.com/24601/halligan/commit/400092a28d43f10fd876e59c90e92d699110ef1c))
* **axir:** port MCP Tasks v2 ([bfe2f5a](https://github.com/24601/halligan/commit/bfe2f5ab07bd1c815534cf631fc057b05bfd7758))
* **axir:** port modern MCP transport headers ([afaae69](https://github.com/24601/halligan/commit/afaae6931c3d9911ef6e4399ac3df3c0ee402f19))
* **axir:** port new Gemini Flash models ([d25acf2](https://github.com/24601/halligan/commit/d25acf280d7f7e8c8a44cc93bab813af9dacf766))
* **axir:** port roots-first MCP MRTR ([0935411](https://github.com/24601/halligan/commit/093541147aa43ff543cd0befc2f8c6b749ff81af))
* **axir:** port the playbook (ACE) optimizer to all 5 generated languages ([968a906](https://github.com/24601/halligan/commit/968a9067352143523b28b6668370db39faf492c9))
* **axir:** port URL arrays and structured stream deltas ([65b1432](https://github.com/24601/halligan/commit/65b14323c079975575823722214e0ecdf0bec61f))
* **axir:** productized realtime_chat WebSocket driver for the C++ port ([a11f9c7](https://github.com/24601/halligan/commit/a11f9c7fcbdd2399bc2af89e06c73b7c7facb0e5))
* **axir:** productized realtime_chat WebSocket driver for the Go port ([72b881c](https://github.com/24601/halligan/commit/72b881cd6cff1a5c6aca1c9b27ec5203a366561d))
* **axir:** productized realtime_chat WebSocket driver for the Java port ([27e23f5](https://github.com/24601/halligan/commit/27e23f517dbd8e63589ba07f714debffcc686b35))
* **axir:** productized realtime_chat WebSocket driver for the Python port ([faabf69](https://github.com/24601/halligan/commit/faabf69ebaa1f35e4cf7f3441fe504e773fa603e))
* **axir:** productized realtime_chat WebSocket driver for the Rust port ([81af022](https://github.com/24601/halligan/commit/81af0227fe17f303e034527399aa71cdc8718f6d))
* **axir:** support audio content parts in OpenAI-compatible chat() across ports ([9119cef](https://github.com/24601/halligan/commit/9119cef49109ab1f02eda990e8830adea4ef8446))
* **axir:** transparently route realtime models through chat() across ports ([ba6e38a](https://github.com/24601/halligan/commit/ba6e38a2de77943e7b0fd1fa781da5e273164e0a))
* **axir:** verify modern MCP round trips ([c6253f5](https://github.com/24601/halligan/commit/c6253f57ebdb3f5d4359338a7f32366b02de9665))
* **azure-openai:** add structured outputs support ([#473](https://github.com/24601/halligan/issues/473)) ([a246518](https://github.com/24601/halligan/commit/a246518abbdaa2195e1a6e67430d625dd0270ffd))
* better agent prompt, more contex policy presets and new callbacks ([7a36501](https://github.com/24601/halligan/commit/7a3650101042b0e8846c9a4a6b5f368736a87f22))
* better image display for ax rome ([9035a35](https://github.com/24601/halligan/commit/9035a359809d4ec3b0165e77daa2e1a822408f28))
* big [breaking] refactor ([c97395d](https://github.com/24601/halligan/commit/c97395d6d7ea5e259151675c19b0cb2f21e0c2a2))
* **caching:** implement caching functionality in AxGen and AxFlow for improved performance ([18158d9](https://github.com/24601/halligan/commit/18158d9ba17f749e98a7814072743911131b84a1))
* chat logs for training data ([874e38f](https://github.com/24601/halligan/commit/874e38f4cf66ffbfad1d62407e9ea2292e5910ea))
* compile mermaid flowcharts into runnable flows via flow.fromMermaid() ([7702484](https://github.com/24601/halligan/commit/7702484f106d7ace5392c43bf1a5ac396948afdc))
* convert any document format  to text and a full RAG engine builtin ([7f3f28c](https://github.com/24601/halligan/commit/7f3f28c0c185506fc479bfd61c1f35588e65cfd6))
* dbmanager handles chunking, embedding and search for text ([5c125f8](https://github.com/24601/halligan/commit/5c125f87d54fba405407bc4085701ffbf4748a45))
* deepen Ax Academy mastery learning ([7cd788c](https://github.com/24601/halligan/commit/7cd788c0fb2e877d59b396960a7492a748e12462))
* deepseek and cohere function calling ([5341700](https://github.com/24601/halligan/commit/5341700a39b80115e9bce50b0176a1c9760a6064))
* docker sandbox function ([a423c45](https://github.com/24601/halligan/commit/a423c450cec5d62d37eb8b0f7d036fddd5b519a5))
* **dsp:** add customTemplate option to AxGen ([#499](https://github.com/24601/halligan/issues/499)) ([63e496e](https://github.com/24601/halligan/commit/63e496ea21d0e69aa0b653d7f9b7a37fc40f8355)), closes [#469](https://github.com/24601/halligan/issues/469) [#493](https://github.com/24601/halligan/issues/493)
* **dsp:** add playbook() concept that wraps the ACE optimizer ([858d55f](https://github.com/24601/halligan/commit/858d55f3d3f1af5ad403fe0019e4da3e7528b32a))
* **dsp:** Separate structured output example input fields with newlines and allow missing required fields during structured output validation in response processing. ([6150f36](https://github.com/24601/halligan/commit/6150f36e20d4840b5615d2433fba79a4e7dac963))
* Enable Anthropic web search by updating beta headers and removing tool filtering, and reorder validator imports. ([60a5663](https://github.com/24601/halligan/commit/60a566344054e14c92666c2c24dd22bc2886399c))
* Enable chat history and multi-turn inputs for AxGen and AxPromp… ([#230](https://github.com/24601/halligan/issues/230)) ([2bdd6ec](https://github.com/24601/halligan/commit/2bdd6ec1db03aee4fe0a425b4008b7b520065de3))
* enable remote logging with LLMC_APIKEY env var ([e04b257](https://github.com/24601/halligan/commit/e04b25797676bced2ecdc10c7368983d54ca2e19))
* end-to-end streaming with parsing, error-correction, validation and function calling ([3b59665](https://github.com/24601/halligan/commit/3b596658221d8b6fef089e972bb32b44d0df600e))
* Enhance abortable request functionality and documentation ([0b0495e](https://github.com/24601/halligan/commit/0b0495eaaf6f8fd265bd47d81424cb3f75ee15d2))
* Enhance AI balancer with capability-based service selection and aggregated features/metrics across services. ([d4acef2](https://github.com/24601/halligan/commit/d4acef251c4f4b369a2c354fa31dd1a86a7dc60d))
* enhance Anthropic API response handling and add demo for thinking separation ([38c5b5d](https://github.com/24601/halligan/commit/38c5b5d60f65deaba854ecdf06cc34cb128ad42f))
* enhance assertion capabilities in AxGen and documentation updates ([2770a07](https://github.com/24601/halligan/commit/2770a074adc883b55dfc655d3d46143dbf00c017))
* enhance Ax framework with new node extension capabilities and type-safe functions ([7d7ea7a](https://github.com/24601/halligan/commit/7d7ea7ae5a6921923b50d2c98db40f827b12a972))
* enhance ax function with customizable thought key support ([1e02d29](https://github.com/24601/halligan/commit/1e02d29e1cef7dffacf521599f6d743d1a912c37))
* enhance ax() and agent() functions with AxSignature support ([ca860ae](https://github.com/24601/halligan/commit/ca860ae8863cde344a397e523787a40ce707b144))
* enhance AxAgent with agent function management and sharing capabilities ([9ab332b](https://github.com/24601/halligan/commit/9ab332b697372aab586097df635d998ef655be3d))
* Enhance AxAgent with demo validation and descriptions ([462bc72](https://github.com/24601/halligan/commit/462bc7224852f26e28ffe6acb042f90d26fb1b6b))
* Enhance AxAgent with recursion options and action description logging ([908303d](https://github.com/24601/halligan/commit/908303dd2f0c1da146511f166cbb576c34887adf))
* enhance AxAgent with structured context fields and improve documentation ([b149463](https://github.com/24601/halligan/commit/b1494632c818048aad75e70e27a44ad5521fa77c))
* enhance AxAIGoogleGemini tests for thinkingBudget preservation ([dbe1245](https://github.com/24601/halligan/commit/dbe1245fb50f10bf2120b7a7230ad774d1b89e05))
* enhance AxExamples utility and improve fluent API type inference ([45897fc](https://github.com/24601/halligan/commit/45897fc19404197a01c91ba7b7aaa9c54c1e03cc))
* enhance AxFlow documentation with new node types and custom program examples ([0ca143e](https://github.com/24601/halligan/commit/0ca143e81a23e58d6411c65d8a7e5f01f3bdd85d))
* enhance AxFlow with asynchronous transformation capabilities ([06e17b8](https://github.com/24601/halligan/commit/06e17b873f5a97a7bd6a543aaa464f0682f10047))
* enhance AxFlow with instrumentation and optimization features ([0e39a24](https://github.com/24601/halligan/commit/0e39a249c076e24445dccbf74181275fa9fe5254))
* enhance AxFlow with new features and examples ([caf8442](https://github.com/24601/halligan/commit/caf84421d5c6446196ee79b728db98053bd2871f))
* enhance AxFlow with node-level usage and trace tracking ([5620235](https://github.com/24601/halligan/commit/56202354bc48ea6342d445122bc5d1e06ecc5ff1))
* enhance AxGen and AxSignature validation and parsing ([433b232](https://github.com/24601/halligan/commit/433b232ce843460ac8b41e3d73aaad63c5cb6f3d))
* enhance AxJSRuntime with output mode and usage instructions ([fe07dec](https://github.com/24601/halligan/commit/fe07dec250a88ba3f267c7dcfe9715a5f55328fd))
* enhance AxMiPRO v2 with self-consistency sampling and validation example updates ([4f334a3](https://github.com/24601/halligan/commit/4f334a396d9b0f06502729be41b4f28d1df4c206))
* enhance chat request message validation and model info ([3bea574](https://github.com/24601/halligan/commit/3bea574e60494b9099dd145cb1f1887baadc3d29))
* Enhance complex object and JSON extraction, add validation tests, and improve error messages with LLM output. ([100ed60](https://github.com/24601/halligan/commit/100ed602c14ea08d155ba4669c8620dad0a6ae1c))
* enhance context field handling and improve type normalization in RLM ([bdd2ccd](https://github.com/24601/halligan/commit/bdd2ccda23f30a0a617bb988f6ee41b3608fb96c))
* Enhance context management with updated tombstoning options and new example ([09a9c25](https://github.com/24601/halligan/commit/09a9c255637d25a859abbbeeda0eee2116bf95e8))
* enhance debug handling in AxBaseAI and global settings ([355640b](https://github.com/24601/halligan/commit/355640bd6a47730f8a05bb535d8f03b43d2f8f7f))
* enhance documentation and introduce telemetry guide ([b581aa3](https://github.com/24601/halligan/commit/b581aa3aa63aab78d91d22e6a6d97db05438a2e3))
* enhance documentation with new Examples Guide and improved links ([e39300b](https://github.com/24601/halligan/commit/e39300be36efa59267a98508cfde51c9ab5022a0))
* enhance error formatting and template rendering ([1dc59ae](https://github.com/24601/halligan/commit/1dc59ae8dfcd52f32d7447d343ab8780e09c3447))
* enhance error handling by providing focused source context for runtime errors ([7b3e5ee](https://github.com/24601/halligan/commit/7b3e5eee39229c35fd9b5c4698ae757de6d49012))
* enhance error handling in AxJSRuntime ([ed939cf](https://github.com/24601/halligan/commit/ed939cfbbe6669453a390dd427a77448c80a6fa5))
* enhance error handling with data preservation in AxJSRuntime ([272a8ee](https://github.com/24601/halligan/commit/272a8eef40518729ba28f4d2af9dea12e19531c2))
* Enhance GEPA optimizer with new configuration options and structured optimization report ([f0ef34a](https://github.com/24601/halligan/commit/f0ef34a58aea257924c96864cdba6dc4a7165764))
* enhance JSON parsing and streaming response handling [#480](https://github.com/24601/halligan/issues/480) ([b9e7933](https://github.com/24601/halligan/commit/b9e7933ab91043b2d25ef9031c73603c42934511))
* Enhance JSON schema validation with flexible handling of union types ([967610d](https://github.com/24601/halligan/commit/967610df7cee8e9de11fd9a27835f35398d43c66))
* enhance logging and error handling for streaming responses ([ca8d124](https://github.com/24601/halligan/commit/ca8d1244bbae3367f4f4a015b81bc7857600ac73))
* enhance logging and error handling in AI components ([43ae472](https://github.com/24601/halligan/commit/43ae47246147c4ab9328c326fb3bdb8216043292))
* Enhance logging capabilities with structured tags ([2bb76d3](https://github.com/24601/halligan/commit/2bb76d3926d08d32c1a12fc651ee3434d3876bc9))
* enhance logging functionality with ChatResponseCitations support ([ec87e3a](https://github.com/24601/halligan/commit/ec87e3a5af7e17293ccd0528c57220d464ca5c73))
* enhance MemoryImpl to support updatable messages and improve updateResult logic ([8afe0ff](https://github.com/24601/halligan/commit/8afe0ff7f6814030bbc0c345e5eff752badd4e2e))
* enhance MiPro optimizer with new sampling and result picking features ([92deebd](https://github.com/24601/halligan/commit/92deebd64708f74474fffbab8614d6786164ab58))
* enhance MiPro optimizer with result explanation and logging ([2191a25](https://github.com/24601/halligan/commit/2191a251317b98debe8fc6dd3eca682f433ec0d6))
* enhance multi-modal support in AxChatRequest and provider capabilities ([38ac67f](https://github.com/24601/halligan/commit/38ac67f9fa6afc8a12b800a68546c5ee941d3741))
* enhance NotebookCell and NotebookPlayground with responsive design and improved UI elements ([46cfc4d](https://github.com/24601/halligan/commit/46cfc4ddfab81d44b45e92bce926ca508fd15e0b))
* enhance NotebookCell and NotebookPlayground with signature handling ([8a4c887](https://github.com/24601/halligan/commit/8a4c88771d07746e91f5361e42226606daad91e4))
* enhance OpenAI model handling with reasoning checks ([a58904b](https://github.com/24601/halligan/commit/a58904b4f8d857ecef974ecd704897dc05442741))
* Enhance OpenTelemetry integration and introduce thinking token budget ([a8a08dc](https://github.com/24601/halligan/commit/a8a08dc2525dd1dbe02e5dc964aefcebcf24a185))
* enhance postbuild and postinstall scripts for skill file handling ([28d260b](https://github.com/24601/halligan/commit/28d260b61eacc8b4de2a9352b2f6c90a8447aadf))
* enhance README and CLI functionality [#482](https://github.com/24601/halligan/issues/482) [#475](https://github.com/24601/halligan/issues/475) ([67bf283](https://github.com/24601/halligan/commit/67bf28319f88e5cc864fd95bcc0df92287192b1b))
* enhance README and examples for browser compatibility and CORS support ([1ad5983](https://github.com/24601/halligan/commit/1ad5983202c7284e139e375f91db47d7e25dce73))
* enhance README with new examples and Fluent Signature API ([5cd30db](https://github.com/24601/halligan/commit/5cd30db98271646f3119d2fd96a734063928cc80))
* enhance response mapping for OpenAI integration ([61204ce](https://github.com/24601/halligan/commit/61204cea71704c37e832be96cc99c97853ca6ca4))
* enhance RLM session management and error handling ([77493d5](https://github.com/24601/halligan/commit/77493d542f994f47f5ac218a804f1860f265295e))
* Enhance shared fields handling in AxAgent and add new tests for parameter scoping ([f8002bc](https://github.com/24601/halligan/commit/f8002bc66f5ba22d64be90397866c4d7d4e68ae9))
* enhance structured output handling with distinct extraction modes and improved prompt rendering for complex fields ([7ad07fe](https://github.com/24601/halligan/commit/7ad07fe0fec65dbcce6e43747206257e8cf775cc))
* enhance tagged template literals for AxGen and AxSignature ([9003b9f](https://github.com/24601/halligan/commit/9003b9f8866d27a50b27a4f42d7ed9287de9a33f))
* Enhance thinking token budget configuration and introduce Grok AI support ([0d73693](https://github.com/24601/halligan/commit/0d736936aac8ba5065b2a75989b5db653bc33bc1))
* enhance type definitions and re-export common types for optimization ([c178bca](https://github.com/24601/halligan/commit/c178bca3871f2567aa2cb77d9574496fd774b1b6))
* enhance type safety and inference for AI models ([71cfb3a](https://github.com/24601/halligan/commit/71cfb3ab79217a68a5e4f965755ad84bea2828c7))
* enhance type safety in Ax framework with dynamic signature parsing ([eb4f138](https://github.com/24601/halligan/commit/eb4f1387a0e5c9747f72867b5314ceefbf990eb1))
* enhance validation and logging in AxGen and extraction processes ([d06dde1](https://github.com/24601/halligan/commit/d06dde17f85561150ae02ebc039acfd6cc3b292f))
* enhance validation for file content in chat requests ([4f289af](https://github.com/24601/halligan/commit/4f289afedbb3e49196ae82f4f45a9cd674d99ffe))
* enhance validation for media content in chat requests ([aa8e721](https://github.com/24601/halligan/commit/aa8e721af574705971da52a183a4022163ad0399))
* **event:** add advisory demand boundary ([d06cb37](https://github.com/24601/halligan/commit/d06cb372b105e6bd5d5ebcb323750e6726beb992))
* **event:** add conforming SQLite event store ([c285545](https://github.com/24601/halligan/commit/c2855458b00409187ff366f2486465db09129626))
* **event:** add effect-aware resumability ([22354cf](https://github.com/24601/halligan/commit/22354cf58c06766a15dfd305a074a4685727e388))
* **event:** add temporal interaction timeline ([e90323d](https://github.com/24601/halligan/commit/e90323d14e10218185e443303b1343d24673b5dd))
* **event:** add transactional component lifecycle ([eba59c6](https://github.com/24601/halligan/commit/eba59c68670f657c7d3b163a5bdc3b4c91d25545))
* **event:** add verified UCP webhook runtime ([a45be52](https://github.com/24601/halligan/commit/a45be52e82e2f8f9569929692544ea4579e17811))
* **event:** add verifier-gated continuations ([537ce6e](https://github.com/24601/halligan/commit/537ce6e98c3813a3fd723261261deeb3af7ae87b))
* **event:** add volatile AxEventRuntime core ([4785634](https://github.com/24601/halligan/commit/47856347b35aed15f2ec0f7884c235f0868c3f88))
* **event:** bridge MCP notifications and tasks ([0a9a35d](https://github.com/24601/halligan/commit/0a9a35d3b5c5e09398c16f805c0fe25a0810ffb1))
* **event:** port deterministic runtime through AxIR ([f4aad7a](https://github.com/24601/halligan/commit/f4aad7ac0a10cb7d8c7484b52c8d72be7243caa0))
* expand testing documentation and improve type definitions for Ax framework ([ca96127](https://github.com/24601/halligan/commit/ca961276dddc0fe79e1a292f6bddf464d525d4de))
* extend Ax framework with new AI capabilities and improve type safety ([489e458](https://github.com/24601/halligan/commit/489e4583dfad5bba4901f2f843344fbcf3e41bc7))
* extend signature string grammar with modifier bags and nested objects ([2f6b422](https://github.com/24601/halligan/commit/2f6b42236de482fda6e711d3f0e613ce285fcfff))
* first release of rome ([7629b77](https://github.com/24601/halligan/commit/7629b77be1e139ad9e1a6d93a30e6b62423bb82f))
* **flow:** add description and toFunction methods for enhanced flow metadata ([54dfaca](https://github.com/24601/halligan/commit/54dfacac6f609016f2306a02f76d28cfd726028a))
* gemini 2.5 flash with thinking budget config ([da5bfd1](https://github.com/24601/halligan/commit/da5bfd16cd5ef4390873e983e9f303ec463e25b8))
* gemini code execution added ([29a7e9c](https://github.com/24601/halligan/commit/29a7e9c46f57ffe0f19f778d25fcef2cd1b5f587))
* **gemini:** add 3.6 Flash and 3.5 Flash-Lite ([3fb5a8a](https://github.com/24601/halligan/commit/3fb5a8a41b5aab69a826e5ec4722360226dc1bec))
* **gemini:** add Gemini 3 support with thought signatures and function calling ([7b6a499](https://github.com/24601/halligan/commit/7b6a4991468754ec5069852dfcc9e7bf946ce2ae))
* gemma 2 ([85ffdd3](https://github.com/24601/halligan/commit/85ffdd3aee103e547fc715ca22fc2a9c2de48f6b))
* gepa optimizer for axagent and other features ([12e0644](https://github.com/24601/halligan/commit/12e0644cc21c521904b14ac9c5bd43f8a60c99ca))
* GEPA: enable optimizedProgram interface to mirror MiPRO ([#350](https://github.com/24601/halligan/issues/350)) ([9b1ae9a](https://github.com/24601/halligan/commit/9b1ae9a21c62ec913bad5dc38481a271e3facac2))
* **gepa:** add proposal policy guidance ([369fcc6](https://github.com/24601/halligan/commit/369fcc66514190be2ee62042f43f529b0ea9af5a))
* **gepa:** add structured metric feedback ([0661363](https://github.com/24601/halligan/commit/0661363207db78e6c663700968f0d9fc40abfc33))
* **gepa:** GEPA/GEPA-Flow Pareto optimizers + docs alignment ([#341](https://github.com/24601/halligan/issues/341)) ([f61c18a](https://github.com/24601/halligan/commit/f61c18a9b11a6e36f783f6937c0e9104cf168c1f))
* **gepa:** persist candidate decision lineage ([9e5b5cf](https://github.com/24601/halligan/commit/9e5b5cfa14d42c7147d65e92e6a1304ca66e16fd))
* gpt-4o added ([a388219](https://github.com/24601/halligan/commit/a388219ec52cfcef132199453f55ecb7c489156e))
* harden stop/abort behavior across AxGen, AxAgent, and AxFlow ([a5c7f9b](https://github.com/24601/halligan/commit/a5c7f9b48657d5b7986a3a31fc19a6f4f71fdd39))
* huggingface data loader ([47c6c0e](https://github.com/24601/halligan/commit/47c6c0efcfa468466dc54af2c92cc970821d30e2))
* implement abort functionality in AxAgent, AxGen, and AxFlow ([d450bbd](https://github.com/24601/halligan/commit/d450bbdcf6cb447a5fd4a8b1225bafe31f65ca52))
* Implement abortable AI requests with AxAbortableAI utility ([b8f5201](https://github.com/24601/halligan/commit/b8f5201c5d75d19549e79805a378936118ebf8f2))
* Implement and document parallel function calling for Google Gemini. ([cb1a310](https://github.com/24601/halligan/commit/cb1a310800373d5e469044d747d112da46e8305e))
* implement citation handling and logging in response processing ([a0aeb77](https://github.com/24601/halligan/commit/a0aeb77f1aa74829eb37243174165f3c24b2ac4a))
* implement dark mode support across the documentation site ([2e56916](https://github.com/24601/halligan/commit/2e5691673cd89bde4e1afea730d7243369276f92))
* implement enhanced logging functionality and naming conventions ([bb6f47a](https://github.com/24601/halligan/commit/bb6f47a012b264c99f8f00dda5bc6effb76ae006))
* implement error handling and retry logic in evaluation and optimization processes ([e34f37a](https://github.com/24601/halligan/commit/e34f37af40eb2db813abcd86f7543a9ba47aff47))
* implement expensive model safety checks in AxBaseAI ([f50cb59](https://github.com/24601/halligan/commit/f50cb59cb50539a3091ab749f2d38c50b666c7c9))
* implement function/tool call tracing for enhanced observability ([58664d0](https://github.com/24601/halligan/commit/58664d0d8164af5558dce51e0dba70e294d68f82))
* Implement getUsageInstructions method in AxCodeRuntime and update related usages across multiple files for consistency ([7f2dfcd](https://github.com/24601/halligan/commit/7f2dfcdc8eebd59f5add6defed761412cfffa575))
* Implement infrastructure-level retry for service network, status, and timeout errors, adjusting default retry and step limits. ([807ad4f](https://github.com/24601/halligan/commit/807ad4fa279ba8883481d4656ed23e652bf3b78d))
* implement interactive notebook playground for LLM signatures ([9afeb5d](https://github.com/24601/halligan/commit/9afeb5d5ee1ba79ae154b84210bb5b8a490df16d))
* implement patchGlobals method for AxCodeSession and update related functionality ([ef03ceb](https://github.com/24601/halligan/commit/ef03ceb2975137a8084fb4f717c495f212c9055f))
* implement RLM session recreation and error handling ([2158092](https://github.com/24601/halligan/commit/2158092aa1b150ad7446f6c5c15da2bcc7f09a71))
* Implement semantic context management in AxAgent ([899540b](https://github.com/24601/halligan/commit/899540b02f9f0d0ef60ff942ecc2a676a50c53de))
* implement session auto-recovery after timeout and improve error handling ([7f76d94](https://github.com/24601/halligan/commit/7f76d944365916ce120c3c94cfaa9f67eb134657))
* improve ax agent context management ([7b974ad](https://github.com/24601/halligan/commit/7b974ade805c42d70b8b94a238f8736340ad984b))
* improve code blocks in rome ([ab58949](https://github.com/24601/halligan/commit/ab589496f6b663b4b378d3db0acd8d4099f90ac9))
* improve error handling in AxJSRuntime and integration tests ([799a425](https://github.com/24601/halligan/commit/799a4257016ee662ce9be24464895c7b047db13c))
* Improve streaming error handling by distinguishing validation from parsing errors, optimize signature complex field detection, and add API request debug logging. ([117e7d2](https://github.com/24601/halligan/commit/117e7d27f0ffd56152fc4ff50931d6783748b8a5))
* Improve streaming retry logic by resetting state and committed values, and clarify complex field detection for output signatures. ([0bf9d87](https://github.com/24601/halligan/commit/0bf9d87f758c5b45faafdbeab1f4996dc86c70a0))
* improve trace logging ([12776be](https://github.com/24601/halligan/commit/12776be18d2d4795a018ff3e2bf710288586b589))
* improved debug logs ([38e869e](https://github.com/24601/halligan/commit/38e869e1be07ca7a0193bbb908819bd6759b561a))
* improved errors ([f57592e](https://github.com/24601/halligan/commit/f57592e5ebb528ed2d5f1b90cd029f0782a88267))
* improved function argument error correction ([4325101](https://github.com/24601/halligan/commit/4325101b9b951556d9d8c44b4b835058cc87ad81))
* improved type system for axflow ([649b5e4](https://github.com/24601/halligan/commit/649b5e47a88a3b89807bc7dcdaf45079970a022c))
* improvements to the live runtime state system ([0ed618d](https://github.com/24601/halligan/commit/0ed618d330589275339a3cbe98c1ee2f79b18d2c))
* include reasoning in tracing ([e11f665](https://github.com/24601/halligan/commit/e11f665626ab34f462c73e7e05dd74db7b27d1fd))
* infer extended signature grammar at the type level ([e7a8e3a](https://github.com/24601/halligan/commit/e7a8e3a8445f1611807d2d8e2447c7fa95534f93))
* integrate new transport classes and enhance OpenAI response handling ([5b3ea86](https://github.com/24601/halligan/commit/5b3ea860fc4aa640307a441e1d5785f0176b7219))
* integrate OpenTelemetry metrics for enhanced monitoring ([5f8265c](https://github.com/24601/halligan/commit/5f8265c28de89bfa6aab123c81e1e4358c6e9349))
* integrate Python optimizer service into Ax MiPRO ([bfcb759](https://github.com/24601/halligan/commit/bfcb759abce818c879475f09e90e024ad0dd99b7))
* integrate Vercel AI SDK v5 support and update dependencies ([3acb408](https://github.com/24601/halligan/commit/3acb4085e14b8845f075c84bdd55c5e9277b6b71))
* Introduce `AxSignature.hasComplexFields()` for consistent complex type detection and update example documentation. ([b1dc107](https://github.com/24601/halligan/commit/b1dc10733053ace5720f0f7daedb633e3789468d))
* Introduce `AxTokenLimitError` for specific token limit detection in AI API calls and add configuration for retrying on such errors. ([69539df](https://github.com/24601/halligan/commit/69539dfff03724812f852a4eff2a27c56d3e1b1d))
* introduce `cacheBreakpoint` option for granular control over context caching in prompts and Anthropic API. ([5100807](https://github.com/24601/halligan/commit/5100807d3b37e9e2fb3b1126352cdb1eb45bd3a6))
* introduce AI context caching with breakpoint semantics for prompt hashing and update documentation. ([a9f38d3](https://github.com/24601/halligan/commit/a9f38d3bff37d6ca8efd638fdbff108a0bb14f1a))
* introduce automatic parallelization in AxFlow for enhanced performance ([9f27182](https://github.com/24601/halligan/commit/9f27182404cd1ca8aae7e4359d148080c4931b3a))
* Introduce AxAIOpenAIResponsesModel and enhance responses API integration ([0ab61f8](https://github.com/24601/halligan/commit/0ab61f8020afb3e402c5e178ce9a82da00e797ac))
* introduce AxFlow workflow orchestration (Beta) in README.md ([0d8d0e4](https://github.com/24601/halligan/commit/0d8d0e4ebbc1b8e9152ca0915f4d054bc1602e55))
* introduce AxForwardable interface and enhance AxFlow execution capabilities ([c694c91](https://github.com/24601/halligan/commit/c694c910ed44f6162556d2f9f2b719b2a65635eb))
* introduce AxMCPClient enhancements and new documentation ([fc2e2ec](https://github.com/24601/halligan/commit/fc2e2ec8ad546882ddd3e5e09fdb8be27735ee05))
* introduce axRAG for advanced retrieval-augmented generation capabilities ([dc3e466](https://github.com/24601/halligan/commit/dc3e466486910ea79e1f3342a1002013b602efff))
* introduce AxRLMJSInterpreter with sandbox permissions and update documentation ([2f0e990](https://github.com/24601/halligan/commit/2f0e990c17ef5e841f43c62b601f7f86b37533e8))
* introduce AxStopFunctionCallException and enhance function call handling ([71e8e63](https://github.com/24601/halligan/commit/71e8e633f0f1a009b86552a3046967221ae29038))
* introduce AxThoughtBlockItem type and refactor thought block handling across AI models ([ad92200](https://github.com/24601/halligan/commit/ad9220000aa259842d3479910899a749d9e0443f))
* introduce comprehensive LLM optimization guide and checkpointing functionality ([d8b5e90](https://github.com/24601/halligan/commit/d8b5e904e8169baf454de511f321a365c76042e3))
* Introduce custom logger functionality for AI services ([a5eaed1](https://github.com/24601/halligan/commit/a5eaed118a1c880cdaef32a81763a7f4d6aa4fce))
* Introduce date and datetime format validators, add dedicated email type factory, and clarify format validation syntax in documentation. ([c9b16a6](https://github.com/24601/halligan/commit/c9b16a6c04ba22a130672b17e2f2f7ed01c50ed8))
* introduce enhanced MIPRO v2 optimizer with AI-powered instruction generation and Bayesian optimization ([3372f87](https://github.com/24601/halligan/commit/3372f875bf9d07c7bbf30b3439cb6d9e84e25b44))
* introduce fluent API for complex signatures in Ax framework ([f64c5d9](https://github.com/24601/halligan/commit/f64c5d9388c29d7c75537d0e310449f91de1bbaf))
* Introduce new DSP modules (agent, tuner, synth, judge), enhance API call retry logic with `Retry-After` header support, and update documentation and examples. ([8c58902](https://github.com/24601/halligan/commit/8c5890221a1ee1c0d61315d87f580f905b07025b))
* Introduce optional output fields in examples and enhance prompt template validation ([71ac8f1](https://github.com/24601/halligan/commit/71ac8f1d1b30bfa9950503f52e91f7851096f6a8))
* introduce parallel map with batch size control for optimized resource management ([8ffda71](https://github.com/24601/halligan/commit/8ffda71093fd610a5d5ff9963d93f58e66878f13))
* introduce returns() method for enhanced type inference in AxFlow ([c586bcd](https://github.com/24601/halligan/commit/c586bcd283ea50341ef46de9f634ef71b2696a9e))
* Introduce structured (XML) prompt generation with format protection and tests, and remove individual streaming result logging. ([f04c787](https://github.com/24601/halligan/commit/f04c7879f6a84ac379906fe001ab6560ce35bf80))
* Introduce tagged template literals for type-safe signatures ([f52267c](https://github.com/24601/halligan/commit/f52267c965c6d050f14d86b1ce5c2e5fe9a4498a))
* Introduce thought handling and enhance thinking configuration ([8c9c8c4](https://github.com/24601/halligan/commit/8c9c8c443d23b70a04e6c7578d29aff7277a9d84))
* introduce type parameterization for AI services and models ([2aa97ba](https://github.com/24601/halligan/commit/2aa97ba8786c7c42f4c5e78ead4d5c273f5d96a0))
* introduce WebLLM integration for enhanced AI model capabilities ([3d7a6d9](https://github.com/24601/halligan/commit/3d7a6d971ef722207ec9c10f792bb929603ef1c4))
* iterate to completion if max token length reached ([f9d0f50](https://github.com/24601/halligan/commit/f9d0f508609355dd93090e0021b73693733f3a52))
* JS code interpreter function ([b3de309](https://github.com/24601/halligan/commit/b3de30939e1f1f91e59c851d2a9f9600ca4ebed9))
* library is now down to 1 single dependency ([efaaa03](https://github.com/24601/halligan/commit/efaaa0338dbd8d2e8f272c7965bf5afb999e4276))
* llm converts meeting notes to trello tasks example ([633cb95](https://github.com/24601/halligan/commit/633cb956e3c04cced5006d2b32198dd3b42e13db))
* lots of api improvements and many bug fixes ([036cd06](https://github.com/24601/halligan/commit/036cd0662b80b3ef8e5e4994d00746ac74024a0b))
* major docs cleanup and nw website ([cc9adca](https://github.com/24601/halligan/commit/cc9adca0a46082b9ce103a900720198be6bbf404))
* major prompt refactor for better performance ([3b718a0](https://github.com/24601/halligan/commit/3b718a00ecc727bc10c4a4657e1d24f3ec9fe455))
* major refactor to enable traceing and usage tracking ([a7c980c](https://github.com/24601/halligan/commit/a7c980cb3f2e50ca1bd012c280a7bd8147978b91))
* make Ax Academy newbie-first ([e064894](https://github.com/24601/halligan/commit/e0648944a2d9074847a42e0a79cb0c14bceb6f89))
* make it easier to customize prompts ([1870ee7](https://github.com/24601/halligan/commit/1870ee77a0a3491a34570033197efeb87a6f632a))
* massive improvements to axagent context policy ([4b9772f](https://github.com/24601/halligan/commit/4b9772f8457b535a0e661536b118cbdfef5244bd))
* **mcp:** add 2026-07-28 protocol types ([dceed8b](https://github.com/24601/halligan/commit/dceed8b45870325f80bb82551e5662cf09e11d10))
* **mcp:** add dual-era stateless client core ([d5c3b5f](https://github.com/24601/halligan/commit/d5c3b5f97f0e2d4d239cab000c5d4b869d8ddc3a))
* **mcp:** add modern transport header plumbing ([4b3bf5b](https://github.com/24601/halligan/commit/4b3bf5b3b4172616c7600c928b80352e31079a07))
* **mcp:** add native MCP and UCP execution ([9c05203](https://github.com/24601/halligan/commit/9c0520371669a553eed605351fdd5417a734da1f))
* **mcp:** add schema-driven parameter headers ([f55a529](https://github.com/24601/halligan/commit/f55a5297d68b20c3365357b74623a41806d8e623))
* **mcp:** add subscriptions and cache TTL ([2907843](https://github.com/24601/halligan/commit/29078437badf25fed3e1b7ead3812b61a972d169))
* **mcp:** add tasks extension v2 ([5ac2f72](https://github.com/24601/halligan/commit/5ac2f72e8b68c2999f248d29213fbd9735f67841))
* **mcp:** add typed protocol and oauth issuer errors ([933fe0a](https://github.com/24601/halligan/commit/933fe0a8d780f5d31d49fdb079b38897062951b5))
* **mcp:** define modern port boundaries ([db2714d](https://github.com/24601/halligan/commit/db2714d0729d223dc2b3af8b318d82684fed5567))
* **mcp:** document dual-era client ([4d479b9](https://github.com/24601/halligan/commit/4d479b97f933b977c6c79d98fe2fc4b984fb7b96))
* **mcp:** OAuth 2.1 for HTTP/SSE transports + Notion OAuth examples ([#340](https://github.com/24601/halligan/issues/340)) ([4f8c922](https://github.com/24601/halligan/commit/4f8c922627ad6d973c42615d8eb0d7f9e7a649d1))
* **mcp:** port MRTR elicitation ([f053c73](https://github.com/24601/halligan/commit/f053c737285a7a6dea38f9b653fb601d402d4658))
* **mcp:** port OAuth discovery and grants ([ca86192](https://github.com/24601/halligan/commit/ca8619226fe91d893f0e5b51c3ce76a774057456))
* **mcp:** support multi round-trip requests ([2bb681f](https://github.com/24601/halligan/commit/2bb681f310bce68d46c45fb24279fde3b3e4e686))
* migrated a lot of tooling to biome ([f9d18f9](https://github.com/24601/halligan/commit/f9d18f9a763643edff7f6bdcefb0a01cd9c3195a))
* migrated from commonjs to ES2022 ([c8ad44b](https://github.com/24601/halligan/commit/c8ad44b6a61246602afb1c3307d46de6b13e8152))
* mipro v2 ([a7e3ddd](https://github.com/24601/halligan/commit/a7e3ddd1b0aa9aaf633f1f3d9cbbaebb871a9f9a))
* **mipro:** Expand MIPROv2 optimizer to tune instructions and examples ([#453](https://github.com/24601/halligan/issues/453)) ([2f3e6ac](https://github.com/24601/halligan/commit/2f3e6acac97e21268480ccea00c8371658e5f2f7))
* moved comm. core into useChat hook ([f04c35f](https://github.com/24601/halligan/commit/f04c35fc65d5ece9de5cea8a26a8873a15274cde))
* multi-modal dsp, use images in input fields ([a170b55](https://github.com/24601/halligan/commit/a170b555072baa13a2bc577248ae9d67f8c7db6f))
* new agent framework ([1e7040c](https://github.com/24601/halligan/commit/1e7040ce2049afa270efee5528ea5b954f66188e))
* new agent prompt ([6c4df2c](https://github.com/24601/halligan/commit/6c4df2c50d84adcfc2f18c42033ad82aa7ca6be6))
* new ai-sdk-provider ([60e646f](https://github.com/24601/halligan/commit/60e646f64736c06a3017ffe1a853baf296b31308))
* new api allows for more flexibility ([fde4794](https://github.com/24601/halligan/commit/fde479493e376d6212d13612b99d84e0ab1c595c))
* new AxFunctionError for function arg error correction ([6f14c0d](https://github.com/24601/halligan/commit/6f14c0dd491167b52ef7673412e68560485072e0))
* new AxGenerateError ([eac0996](https://github.com/24601/halligan/commit/eac09967cd683e5e05d47ad38b639abfffbe3fae))
* new classification type in dspy signature ([d152eb7](https://github.com/24601/halligan/commit/d152eb70085e5da2ebf7b92fc7a6de3be54cb337))
* new classification type in dspy signature ([3816f80](https://github.com/24601/halligan/commit/3816f8015068090ec7cd2309b8a7b5f516168825))
* new earlyFail option ([0bac127](https://github.com/24601/halligan/commit/0bac127134a3905bbf893f69ef9ee333a9c6f48e))
* new gemini embedding ([278cec0](https://github.com/24601/halligan/commit/278cec07dce03dc4ce152d9fcfc66b99e98d70ba))
* new getMetrics() method on AxAIService for latency and error metrics ([088aaca](https://github.com/24601/halligan/commit/088aaca85b2d4b75718f377f48094c22fb978832))
* new inline and function modse for axagent rlm ([a2b4c0f](https://github.com/24601/halligan/commit/a2b4c0fe5bd9964f1bd6200a5096c301e39f25b0))
* new llm proxy for tracing usage ([ab36530](https://github.com/24601/halligan/commit/ab36530aca00510aa1fc339c38317897caa24064))
* new llmclient command and crawler to embed and vectorize websites ([47a61f2](https://github.com/24601/halligan/commit/47a61f25bd4aa84acc7e0c7e59f73e10338372cc))
* new llmclient command and crawler to embed and vectorize websites ([ede47c5](https://github.com/24601/halligan/commit/ede47c5b01fe17056a813fd44ad659186865f134))
* new models ([e1bb27b](https://github.com/24601/halligan/commit/e1bb27b7aac9f32ce64b6e1b1f4164c5fe4757bf))
* new multi service router ([6886416](https://github.com/24601/halligan/commit/688641644aeb18d6dea1a307c5d6872df982cd36))
* new stopFunction option to return after a function is called ([4a56c9c](https://github.com/24601/halligan/commit/4a56c9cbbb589eaabfec57908899714f2d7a55d0))
* new tagging api for memory ([2538a46](https://github.com/24601/halligan/commit/2538a460894634b16dc8fb5b64b1db68e6024709))
* node thread worker security upgrades ([4a29618](https://github.com/24601/halligan/commit/4a29618db88adac19cf1cb451189b1f37c37cd10))
* **openai:** add GPT-5.6 model family support ([#568](https://github.com/24601/halligan/issues/568)) ([0bbccda](https://github.com/24601/halligan/commit/0bbccdac3c9d789dd12d62286a63c191233837a8))
* **openai:** cache breakpoints on GPT-5.6+ and cache write tokens ([#573](https://github.com/24601/halligan/issues/573)) ([c05b3e8](https://github.com/24601/halligan/commit/c05b3e8c6945c590f5114f7bb6a6ef12e9c38f3f))
* openapi wispher support ([50e864f](https://github.com/24601/halligan/commit/50e864f91806c2d723fe6edd46bc3a6a2ecd17d8))
* **optimize:** attach causal candidate evidence ([d50fe93](https://github.com/24601/halligan/commit/d50fe9314c2dc8be25118ddf847b350b55813b73))
* parsing and processing output fields and functions while streaming ([95a7a93](https://github.com/24601/halligan/commit/95a7a93b9c40f8e7b25a2dd14b3b43d84a8d50fc))
* pass functions in forward() ([0c6a58e](https://github.com/24601/halligan/commit/0c6a58e18858f83d9460331911f5cb2d580058da))
* preserve isOptional and class-option unions in signature field-addition types ([766bd99](https://github.com/24601/halligan/commit/766bd99c020e78008cf9a32de3fa5a8dfa9a852e))
* Prevent stream duplication on retry by tracking committed values and yielding only effective deltas. ([98a8480](https://github.com/24601/halligan/commit/98a8480794712a87bcf59bb0aea2446e511c60c6))
* proxy support for all llms ([1e1edc3](https://github.com/24601/halligan/commit/1e1edc3a6b61dedbb4b45af011c79974f9fdef1b))
* redesign of axagent advanced mode (true recursion) ([e8c075e](https://github.com/24601/halligan/commit/e8c075ead9b45704c5cee831fa591455a6ac26be))
* Redesign of AxAgent to be RLM native ([ddb1f17](https://github.com/24601/halligan/commit/ddb1f17abac3482332797f1f2123f4675aae858e))
* redesigned docs, improved system prompts and other fixes ([6cd870e](https://github.com/24601/halligan/commit/6cd870e7ae89aa32f1d73b87da31de886303cf9d))
* refactor optimization types and enhance MiPro integration ([bd67b18](https://github.com/24601/halligan/commit/bd67b180e94a7a16a6d21a7ad143782fc552d224))
* refresh system prompt <available_functions> after ctx.addFunctions() ([#501](https://github.com/24601/halligan/issues/501)) ([6d8517c](https://github.com/24601/halligan/commit/6d8517c49cbed1b8c246ba2e119b802c021ac9b7)), closes [#500](https://github.com/24601/halligan/issues/500)
* remove flow.fromMermaid/toMermaid — flow(text) and toString() are the API ([f066578](https://github.com/24601/halligan/commit/f0665780ed244d613c73bbb1ab2a607117bb7a50))
* removed nodejs dependencies to only support web standard apis ([7701cb9](https://github.com/24601/halligan/commit/7701cb91afbe9d0a02b4c4886484f00970d14fe4))
* rename `max_tokens` to `max_completion_tokens` in `AxAIOpenAI` ([#156](https://github.com/24601/halligan/issues/156)) ([76f1e53](https://github.com/24601/halligan/commit/76f1e53f33743ee460569bb94d0bd3620db6e328))
* rename AxCodeInterpreter to AxCodeRuntime ([d9b5e9a](https://github.com/24601/halligan/commit/d9b5e9a281baf618ee91c7afed965a2821a182db))
* rename AxJSInterpreter API to AxJSRuntime ([c0a6f13](https://github.com/24601/halligan/commit/c0a6f1371e7503f0a582b0dfdbdefd92210b97c5))
* render AxFlow as mermaid via toMermaid() ([8ae55b4](https://github.com/24601/halligan/commit/8ae55b41746b488e682765e0edb9b1c8e93ede98))
* replace `AxLearnAgent` and `AxTuner` with `AxLearn` and update GEPA optimizer to include instruction in Pareto results. ([dc2742b](https://github.com/24601/halligan/commit/dc2742bc20a82f5a7336432b435e415e31d72548))
* req tracing added to ai classes ([dad8c3c](https://github.com/24601/halligan/commit/dad8c3caa4f02d70364a3785d9349575b9c102b6))
* restore WebLLM provider and ACE optimizer ([d536956](https://github.com/24601/halligan/commit/d53695673c4a837c114557bbd89f2100ed035a22))
* rewrite of the streaming parser and memory handling functionality to allow for  sampled outputs and increased stability ([d98cfb4](https://github.com/24601/halligan/commit/d98cfb4a7c1efa823985045d44013aaad71798d3))
* rome is rising ([5d7c0f3](https://github.com/24601/halligan/commit/5d7c0f377ecfde91fb5c7fb142cf367e56e3a7ab))
* rome version 1 beta ([1510bd4](https://github.com/24601/halligan/commit/1510bd42b4944d4d65e02bafda54fbd848302109))
* **runtime:** add capability conformance boundary ([630012e](https://github.com/24601/halligan/commit/630012e431420ebcf93c5fffc975fb3ac9706d68))
* **runtime:** add consecutive execution error cutoff and enhance error handling in AxJSRuntime ([f8c06fa](https://github.com/24601/halligan/commit/f8c06faf9d8b39638dc55c8cab33500eb59ec406))
* **runtime:** add speculative programmatic tool calls ([b9098c5](https://github.com/24601/halligan/commit/b9098c5c4e03db03646e92940f1288b0fb29eb5f))
* seperate description and definition for agents ([bbf644c](https://github.com/24601/halligan/commit/bbf644c497501905cba3aee691e552961543ce8e))
* skip examples in prompt template rendering if missing input or output content ([39c6abe](https://github.com/24601/halligan/commit/39c6abe6dce08b7c7f248dcf8a243004cbb0c228))
* smart model routing for agents and sub-agents [Breaking Changes] ([1d313b4](https://github.com/24601/halligan/commit/1d313b450db62f6da9dd8bf4f4fd52a37b89120b))
* spider to embed website ([56f4598](https://github.com/24601/halligan/commit/56f45984f894a790f93819464e0dc0a91b4bc66f))
* state management and gepa optimization for axagent ([48fb04b](https://github.com/24601/halligan/commit/48fb04b41d806f57e2585e5b37a454c626f114fd))
* streaming support ([65839a9](https://github.com/24601/halligan/commit/65839a9fc041853af10971474bb2f1417919d0d3))
* support `image[]` and `audio[]` in signatures ([#307](https://github.com/24601/halligan/issues/307)) ([15259d0](https://github.com/24601/halligan/commit/15259d0f53e8d65bf89182b35d665770601b16b4))
* support for google vertex ([49ee383](https://github.com/24601/halligan/commit/49ee3833e5f2fc423ca8c059670157b20acc8ac6))
* support for Hugging Face and other updates ([8f64432](https://github.com/24601/halligan/commit/8f644328ab10fcd409b98b02807a96fdccbc79e7))
* support for multiple sample response streams and non streaming multi sample response ([231ecca](https://github.com/24601/halligan/commit/231ecca988907809f6b7de8e691ced518bc0cf0d))
* support for remote tracing ([033a67a](https://github.com/24601/halligan/commit/033a67ab5f6e1f2778ec435fa0e6f181223b6728))
* support for zod / standard-schema/spec ([82583ee](https://github.com/24601/halligan/commit/82583ee96258852c6f71c17b7c7282529af61701))
* track token usage ([bd4f798](https://github.com/24601/halligan/commit/bd4f79824a29a89fed60b38bcef28e2935cebb86))
* true realtime output validation while streaming ([4308b99](https://github.com/24601/halligan/commit/4308b99a8855595527fbd161920ae6968292650c))
* unify GEPA and MiPRO interfaces for consistent optimization workflows ([7cf8e28](https://github.com/24601/halligan/commit/7cf8e289dbc38af57cb08e6e92b0ebbbcb2516bb))
* unify JavaScript runtime interpreter across packages ([9b0c0f7](https://github.com/24601/halligan/commit/9b0c0f7b5d6eb1bbea216d0f7264eb092670a798))
* unify optimization results in MiPro with new AxOptimizedProgram implementation ([305c703](https://github.com/24601/halligan/commit/305c703a11afbf849b14634814e91772c59c67b9))
* update agent function structure to use object notation for functions and agents ([399e454](https://github.com/24601/halligan/commit/399e45436d60a5acb99b8270910acc0955abf137))
* Update Anthropic schema cleaning to preserve `default`, `oneOf`, `anyOf`, `allOf` and conditionally remove `additionalProperties`. ([dbc419c](https://github.com/24601/halligan/commit/dbc419cbb162c1044905dc680df4591471230317))
* update AxSignature and related components for improved usability ([53d8e72](https://github.com/24601/halligan/commit/53d8e7215677684d3a02a4837482da35a22f7aa6))
* update cell ID generation in NotebookPlayground for uniqueness ([c344fa7](https://github.com/24601/halligan/commit/c344fa7ff627cd8419d785559ec8f11bc945bc8b))
* update documentation and enhance metrics integration ([c031e6c](https://github.com/24601/halligan/commit/c031e6cc6e67c4624e72e9e61e00808e263fba7f))
* update documentation to include new file and URL field types ([ecd7b38](https://github.com/24601/halligan/commit/ecd7b38bc645834d894a8512c15611ee8bcee669))
* update fluent API to remove nested helper functions and enhance type inference ([15250f2](https://github.com/24601/halligan/commit/15250f26aa5dc9f6acb6648e0f4a8ba0d9f206ed))
* update input content types and token usage handling in OpenAI responses ([7de977d](https://github.com/24601/halligan/commit/7de977da20f4ba151d362fed96384c98db431990))
* update navigation and playground references to DSPy Notebook ([8137e1c](https://github.com/24601/halligan/commit/8137e1c1aeb59505673a2d2d7a14a2a661df031e))
* update postbuild script and add tests for package exports compatibility ([097d875](https://github.com/24601/halligan/commit/097d87565fb3024d1d05fda4eaa490be47ee0536))
* Update thinkingTokenBudget options and clean up tests ([1b0351a](https://github.com/24601/halligan/commit/1b0351a34d632d10d73cebf3dd241839906c5049))
* updates to agent framework api ([472efbf](https://github.com/24601/halligan/commit/472efbfcfe8f9718a1031263a0363a9a7f72f918))
* use strongly typed model enums in documentation examples ([5201e9c](https://github.com/24601/halligan/commit/5201e9c156513236cb521c7306f7bb18bc647aeb))
* **validation:** introduce Zod-like validation constraints for structured outputs ([a15e5b6](https://github.com/24601/halligan/commit/a15e5b64e3aadb1ed5ac81ac3808ffc089227d12))
* vector db query rewriting ([52fad9c](https://github.com/24601/halligan/commit/52fad9cea59c619fd5d9b74ae5139abbec9c4834))
* vector db query rewriting ([bce6d19](https://github.com/24601/halligan/commit/bce6d198c7f807f4e5a97b8e1211107fecaebb9a))
* vector db support ([0ea1c7f](https://github.com/24601/halligan/commit/0ea1c7f0963946ead1ffc0908a8c5c1be5ce00fd))
* **website:** keep docs side-nav position across pages; chain next page on scroll ([f4f16fc](https://github.com/24601/halligan/commit/f4f16fc1c854353b3adf0399ce2936f04d2e9f00))
* **website:** rework homepage top of page around the real moat ([5ef34b7](https://github.com/24601/halligan/commit/5ef34b743dbd987aac053f20c8befedb0624181d))
* welcome llm-client ([225ec5a](https://github.com/24601/halligan/commit/225ec5aa24cf422ed3018e6fd19e248a0a763391))
* **worker:** add tests for variable persistence across async calls and enhance axWorkerRuntime with top-level declaration extraction ([a2ba6b3](https://github.com/24601/halligan/commit/a2ba6b3e289541a71385a2e16298c65a528fc280))
* **worker:** enhance axWorkerRuntime and getWorkerSource with improved serialization handling and bundler polyfills ([51a9994](https://github.com/24601/halligan/commit/51a9994d6be0ff96697f3b49d285b05097f629eb))
* **worker:** implement axWorkerRuntime for improved worker source management ([9e99e48](https://github.com/24601/halligan/commit/9e99e48aab2745f9bf5ed1b1df737cb4db8d144c))
* wrapped errors to add more details ([164bf94](https://github.com/24601/halligan/commit/164bf949b490429e7372a4bc40e707bd56f94f9c))

### Bug Fixes

* accept any whitespace after the description in type-level signatures ([f283f2e](https://github.com/24601/halligan/commit/f283f2e0bf7cd0cbfd31d1b877744fb4c8164eda))
* accept any whitespace around -> in the type-level signature splitter ([91c072f](https://github.com/24601/halligan/commit/91c072f7f5e5e3109cdc5403771b484396bdc15f))
* Accessing Stream Chunks (Streamed generation) [#36](https://github.com/24601/halligan/issues/36) ([64f661f](https://github.com/24601/halligan/commit/64f661f34de1e97e335ac1032a2064b185ec97d8))
* **ace:** close executable and lineage safety gaps ([d9d8212](https://github.com/24601/halligan/commit/d9d8212b0adc0039eab7c87f4696beee5f957956))
* **ace:** enforce safe atomic playbook updates ([a93699f](https://github.com/24601/halligan/commit/a93699f512c13587d6916af112eeb04330a25052))
* **ace:** Ensure only input fields are passed to curator ([#456](https://github.com/24601/halligan/issues/456)) ([8c0c13f](https://github.com/24601/halligan/commit/8c0c13f00b34281d1b8554107dbb4f06c3f7c401))
* **ace:** keep compile guidance visible and preserve evidence scoping ([0ea3966](https://github.com/24601/halligan/commit/0ea3966df2bdeeefdb1152547415763bc7491d78))
* **ace:** Refine reflector to use only input fields ([#464](https://github.com/24601/halligan/issues/464)) ([695dbf0](https://github.com/24601/halligan/commit/695dbf027304929e98be12f1cab74cc8338e70ee))
* **ace:** sanitize direct executable apply ([7f5e047](https://github.com/24601/halligan/commit/7f5e0472933cb18fad1fba63e7a94ee9cfaf17b0))
* add AxIR terms to spelling dictionary ([592b7fb](https://github.com/24601/halligan/commit/592b7fbe39a7acca265b5c947e4ed69bb3190ca8))
* add GEPA feedback type hooks to AxCompileOptions ([#376](https://github.com/24601/halligan/issues/376)) ([4700c7e](https://github.com/24601/halligan/commit/4700c7e8e92ea3c52d9dd34020d466501dbef6bc))
* add null checks for config parameter in AI implementations ([#240](https://github.com/24601/halligan/issues/240)) ([28664e3](https://github.com/24601/halligan/commit/28664e358ae87fdd9922d27966de0b962a1e6e01))
* add null checks for config parameter in AI implementations ([#241](https://github.com/24601/halligan/issues/241)) ([da148d8](https://github.com/24601/halligan/commit/da148d89779218aece1b33ea27177574af413f52))
* add opentelemetry support and other fixes ([685fe80](https://github.com/24601/halligan/commit/685fe80f1687f97282f708d279e8588023e2213c))
* Add Polyfill for TextDecoderStream to Ensure Compatibility with Bun [#21](https://github.com/24601/halligan/issues/21) ([540348d](https://github.com/24601/halligan/commit/540348d9b25a361077b0e3574064fb4f2975b632))
* add tools support to anthropic ([1cc96b7](https://github.com/24601/halligan/commit/1cc96b7910127c9e00820b572b5fb6ca27662b1e))
* added claude 35 haiku to the info list ([6c6f446](https://github.com/24601/halligan/commit/6c6f446ccfde0f2634aa1aaeb19e6cd0a2d72293))
* added default ratelimiter to groq ([8d74f9e](https://github.com/24601/halligan/commit/8d74f9ee9c99b380b71a38fe66085dbf92ffad8d))
* added missing typescript docs ([2459a28](https://github.com/24601/halligan/commit/2459a282e5cdd8ccc827665fe41f58974023bcfb))
* added system prompt to trace ([335bb40](https://github.com/24601/halligan/commit/335bb406eec22414014bcde8e264bb45bb44ff12))
* agent refactor and other fixes ([2018ddc](https://github.com/24601/halligan/commit/2018ddc583bb15cfe46cdd368b44079989c17a2e))
* **agent:** authenticate restored lifecycle state ([450242c](https://github.com/24601/halligan/commit/450242caff6ba9ee4ba297873d68ba63b2d1c2a6))
* **agent:** authenticate restored session accounting ([844e2dd](https://github.com/24601/halligan/commit/844e2ddb54d73586b2fdb03e19802358bb719afd))
* **agent:** avoid inherited array assignment ([3cfdbd7](https://github.com/24601/halligan/commit/3cfdbd7af2f7d80497e4bbd530025f8bbfdc7fc0))
* **agent:** bound authenticated snapshot imports ([a1330f9](https://github.com/24601/halligan/commit/a1330f960ec46f5dfacabcbbb59b8ad18d01652b))
* **agent:** capture selected handlers before metadata ([3f6ce7d](https://github.com/24601/halligan/commit/3f6ce7d2212966757472cdfd2321f02f7c49b45c))
* **agent:** close retained session audit gaps ([ea3c340](https://github.com/24601/halligan/commit/ea3c3402eba063239e48fa132e0472dc3f908c96))
* **agent:** correctness fixes from adversarial review of P1-P3 ([f4d4ac8](https://github.com/24601/halligan/commit/f4d4ac8deb71c7e7c2be1dbaa84579892db08b98))
* **agent:** document native MCP tools to the RLM actor as mcp.<ns>.tools.<name> ([#575](https://github.com/24601/halligan/issues/575)) ([#578](https://github.com/24601/halligan/issues/578)) ([d1174c1](https://github.com/24601/halligan/commit/d1174c10bbb3944020a423267e560cb6b9f739db))
* **agent:** executor must discover before declaring data unavailable ([6c72769](https://github.com/24601/halligan/commit/6c727693c3b781e9471f75cd6c1d0ebe7d7d4254))
* **agent:** extract code from anywhere in javascriptCode field ([#507](https://github.com/24601/halligan/issues/507)) ([2894bcd](https://github.com/24601/halligan/commit/2894bcd078e295fb10a8fd93c8a2037ecd0a2fc6))
* **agent:** fail closed on null preference records ([a233bc8](https://github.com/24601/halligan/commit/a233bc86af0faa72eba438ef5e81a13d080eab2a))
* **agent:** fail closed on rollback errors ([523b6fc](https://github.com/24601/halligan/commit/523b6fc6b857297f5625f116b0f549573c592de9))
* **agent:** fence retained session recovery ([970f9c8](https://github.com/24601/halligan/commit/970f9c85392de12a796eacc988caf772ee895cd9))
* **agent:** fence retained session recovery ([aa1f07e](https://github.com/24601/halligan/commit/aa1f07ef8e70ea2b077e9e04ea1427848f7c0c96))
* **agent:** harden executable skill admission ([d23d8a4](https://github.com/24601/halligan/commit/d23d8a49801d0c96dff85b800d5bfb5a84c00b6a))
* **agent:** harden preference evidence lifecycle ([8e1152f](https://github.com/24601/halligan/commit/8e1152f8974231ea7e81d8078acbd7e84386c438))
* **agent:** harden preference evidence selection ([45ac57e](https://github.com/24601/halligan/commit/45ac57e0f6757da1995c9ded36442dcd5ca1e837))
* **agent:** harden retained snapshot capture ([1e9c03d](https://github.com/24601/halligan/commit/1e9c03d40a9c118a27457d5dbb85317a16260a58))
* **agent:** harden retention evidence gate ([9e2a70e](https://github.com/24601/halligan/commit/9e2a70eec7d7c502f4328e7803366e4bdcb37fb7))
* **agent:** harden retention evidence handling ([476cfd6](https://github.com/24601/halligan/commit/476cfd6487c2792376cf47530e77e9ca036fbc0e))
* **agent:** isolate executable skill snapshots ([642e575](https://github.com/24601/halligan/commit/642e5750c69b0155512336f5a2defbfd3785f4a8))
* **agent:** isolate malformed preference structures ([0f70af1](https://github.com/24601/halligan/commit/0f70af1aa9723c7059c0850b034918ba733ee958))
* **agent:** isolate oversized preference records ([ac2331c](https://github.com/24601/halligan/commit/ac2331c083b908c1df24eb5e7c993f5452b7ec09))
* **agent:** isolate retention corpus evaluations ([eff209d](https://github.com/24601/halligan/commit/eff209d0ae41d1bcafc630cd9fbe22c069b75135))
* **agent:** keep cancelled roots cancelled and persist successful turns ([59f3891](https://github.com/24601/halligan/commit/59f3891c10efc807cc886fa062917b05723d043d))
* **agent:** keep memories cache breakpoint after setSignature() ([6d7286c](https://github.com/24601/halligan/commit/6d7286ce8ea519f5d80bb3d75e8b2c71b76a8069))
* **agent:** keep restoration sentinel internal ([7cb4885](https://github.com/24601/halligan/commit/7cb48856e2360ee525734caac669f7080ffc0dd1))
* **agent:** preserve usage after failed runs ([d67fced](https://github.com/24601/halligan/commit/d67fced2ea766f6ec392cdd98687b4f051fd8f45))
* **agent:** preserve usage context in internal summaries ([0d10c43](https://github.com/24601/halligan/commit/0d10c4308fc48d8d77e700bc36c649f9cef84b24))
* **agent:** recover from empty model turns and unknown tool calls ([8a44919](https://github.com/24601/halligan/commit/8a44919a97a829ab800b3a73a933f6a9bdc4e00e))
* **agent:** reject executable skill accessors ([5192f3c](https://github.com/24601/halligan/commit/5192f3cd0303b3540fee66b27283c24e8269c451))
* **agent:** reject invalid weighted promotion evidence ([6271d7c](https://github.com/24601/halligan/commit/6271d7c96904e76136262ccd568dd2cb504da21c))
* **agent:** reject multiple code blocks per turn ([#563](https://github.com/24601/halligan/issues/563)) ([1ef0968](https://github.com/24601/halligan/commit/1ef0968cc0b7bd26ec6c0506e929834d2ff837af))
* **agent:** restore failed proposal readback ([7874c87](https://github.com/24601/halligan/commit/7874c87288742326b3fbcec330a58f3b2b84c848))
* **agent:** restrict executable skill metadata ([4bb0d04](https://github.com/24601/halligan/commit/4bb0d042366ab73a316c9e1949d08d7c3fc01410))
* **agent:** retain post-fence recovery work ([ac4e5ae](https://github.com/24601/halligan/commit/ac4e5aeb08100dbe93c9881775b96ad8266e00e6))
* **agent:** retry rejected recovery scheduling ([c6ed1d5](https://github.com/24601/halligan/commit/c6ed1d5ee990f31f60241064ea8ef9fa535b1cd2))
* **agent:** revive the dead stage ::instruction knob; playbook dedupe re-learns pruned lessons; improve() runsPerTask ([052fe52](https://github.com/24601/halligan/commit/052fe52d05ab80f4c008f5ee166774fbc2246289))
* **agent:** roll back dry runs cancelled between candidates ([80c3eee](https://github.com/24601/halligan/commit/80c3eeecd9290f28c68914d6c28b49cf557d89e0))
* **agent:** roll back dry-run accepts if later reval throws ([063120a](https://github.com/24601/halligan/commit/063120a421bbc09e8c3c18f54a0fc35b077cdcf8))
* **agent:** roll back failed playbook dry runs ([2c3a6a7](https://github.com/24601/halligan/commit/2c3a6a7f5a3ad4ded85327b69177e5479f484545))
* **agent:** roll back failed playbook updates ([07a7b4e](https://github.com/24601/halligan/commit/07a7b4ed7d37bbba7e4e73358f3ce137981a2db9))
* **agent:** seal preference retraction invariants ([28675e8](https://github.com/24601/halligan/commit/28675e87cbf879510e7c61fac29a88e24e1dd4c0))
* **agent:** snapshot executable skill inputs ([d9ddc36](https://github.com/24601/halligan/commit/d9ddc361af4a750f064842b2726b377334bccfc3))
* **agent:** snapshot host context before catalog and function roots ([30df73b](https://github.com/24601/halligan/commit/30df73ba3d491706d66ba00df8743834b285b086))
* **agent:** validate resolved function roots ([8cb8848](https://github.com/24601/halligan/commit/8cb8848780b3c063c718a2a106002ebb1eb33ecb))
* ai sdk agent provider update ([096ad0c](https://github.com/24601/halligan/commit/096ad0cca337feae4079293aae032c2325267b8a))
* **ai:** expose includeRequestBodyInErrors on AxAIServiceOptions ([#514](https://github.com/24601/halligan/issues/514)) ([a22531c](https://github.com/24601/halligan/commit/a22531c413247d7a6ab242e5487bf50b5e80a1e6))
* **ai:** harden visual sampler state boundaries ([81058ee](https://github.com/24601/halligan/commit/81058eece3e275fb30f501e97fa34619f47d96a3))
* **ai:** record streaming token usage as deltas, not cumulative ([#516](https://github.com/24601/halligan/issues/516)) ([4f7f417](https://github.com/24601/halligan/commit/4f7f417860d18d051f458579903701e1fe2635c4))
* **ai:** recover from stale context caches ([906d8c5](https://github.com/24601/halligan/commit/906d8c5785c4f388c19ae5c3730274a95617753f))
* **ai:** reject shared visual buffers ([14b6648](https://github.com/24601/halligan/commit/14b6648d2eb409d46c56b0a1ece6520d05ff92d8))
* **ai:** route Vertex multi-region endpoints ([5d56a88](https://github.com/24601/halligan/commit/5d56a887e56c30d91ed86dde92d1d9e159e96c1f))
* **ai:** snapshot visual sampler inputs ([32943a0](https://github.com/24601/halligan/commit/32943a0136b112c182a9695687a7949360a28c09))
* allow Anthropic Vertex API models in model list ([348c71e](https://github.com/24601/halligan/commit/348c71ecde4397fe7c99a879317f6ead90ed81e1))
* allow f.object().array() as input field ([#452](https://github.com/24601/halligan/issues/452)) ([d36ddd6](https://github.com/24601/halligan/commit/d36ddd6e0e09b88c6a7f8e1245a0aed487d79648))
* allow google auth lib to manage token lifecycle ([#119](https://github.com/24601/halligan/issues/119)) ([48a2322](https://github.com/24601/halligan/commit/48a2322f8f4b29dbd165223fc4c186666e2d6b11))
* anthropic function calling ([73f5491](https://github.com/24601/halligan/commit/73f5491137dc738c1793411d0388c1c2012829f9))
* anthropic header issue ([40dbce0](https://github.com/24601/halligan/commit/40dbce0bd2ec03f1c9184e66cf88c8dfec31883c))
* anthropic proxy endpoint ([#7](https://github.com/24601/halligan/issues/7)) ([cf7c793](https://github.com/24601/halligan/commit/cf7c7939c393e85d63721762a6c7cc55c68502d2))
* anthropic, updated other models ([6e83d34](https://github.com/24601/halligan/commit/6e83d34f5acb8be282e172b47d9feeef0ce67436))
* **anthropic:** add anthropic-beta header for web-search on Vertex AI ([#457](https://github.com/24601/halligan/issues/457)) ([df13f8c](https://github.com/24601/halligan/commit/df13f8c97fbdcf25870437f23284232e9b738fb5))
* **anthropic:** correct Claude Sonnet 5 to its permanent token pricing ([#576](https://github.com/24601/halligan/issues/576)) ([526b8fc](https://github.com/24601/halligan/commit/526b8fc460125568ada54dbf02f29bba147ab2b4))
* **anthropic:** correct prompt caching property to cache_control ([20606c7](https://github.com/24601/halligan/commit/20606c71662ba5f77252879e972462639b47071a))
* **anthropic:** emit cache_control on content blocks, not envelopes ([#517](https://github.com/24601/halligan/issues/517)) ([c12a3a8](https://github.com/24601/halligan/commit/c12a3a8374bcd8c626dc312cbd3c8a18841b6d4d))
* **anthropic:** omit sampling params on all adaptive models, not just Opus 4.7+ ([#560](https://github.com/24601/halligan/issues/560)) ([10eecc9](https://github.com/24601/halligan/commit/10eecc9dccee135af7a7175c1f84162b64d9934c))
* **anthropic:** remove unsupported structured-outputs beta header for Vertex AI ([#462](https://github.com/24601/halligan/issues/462)) ([8420adb](https://github.com/24601/halligan/commit/8420adb5e4fbcddeb94bd990f5b84536a2206678))
* **anthropic:** request summarized thinking display on adaptive models ([#561](https://github.com/24601/halligan/issues/561)) ([61bea23](https://github.com/24601/halligan/commit/61bea23f346f61a5821f347a8972c18047af037c)), closes [#560](https://github.com/24601/halligan/issues/560)
* **anthropic:** retry and fail over on transient errors (overload, rate limits, server errors) ([#556](https://github.com/24601/halligan/issues/556)) ([36c7808](https://github.com/24601/halligan/commit/36c7808f1ecd647539da33fd19c4484ce687c0ff))
* **anthropic:** support streaming cache usage and remove beta header ([8fe2bfc](https://github.com/24601/halligan/commit/8fe2bfc1068d5b843c3536b61482148f3ad4afe7))
* **api:** improve handling of empty function parameters in Anthropic, Cohere, and Google Gemini APIs ([e901fdc](https://github.com/24601/halligan/commit/e901fdc675951b67aca7c923885f757d8a152c7a))
* Array elements repeating in Gen response, while OK in model response (Gemini) [#193](https://github.com/24601/halligan/issues/193) ([94d3d2d](https://github.com/24601/halligan/commit/94d3d2d815607bc7a3deb14c0929204c3cdb98f8))
* **authority:** bound onAudit and quiesce event cancel/redrive ([003fddd](https://github.com/24601/halligan/commit/003fddd29cf14de2c574f656d1f746d012cdbef5))
* **authority:** capture dispatch inputs once ([184cdb5](https://github.com/24601/halligan/commit/184cdb5b75cf2847a9a488947b19f66261cac806))
* **authority:** deny allow after cancelled audit and await redrive close ([e0fb3ce](https://github.com/24601/halligan/commit/e0fb3ceaf46c2cdc28d1dc3267788d2e2b3e202c))
* **authority:** namespace MCP resources and swallow late rejects ([6e5d795](https://github.com/24601/halligan/commit/6e5d795e33a843a187f65bebe40247b892a3d41d))
* automatic zod schema creation for ai sdk provider tools ([7ea8600](https://github.com/24601/halligan/commit/7ea86007bcbe455c9edaa03bcc01e5f22ca780b4))
* ax ai provider ([b87bf02](https://github.com/24601/halligan/commit/b87bf0275b0d2b9edc1435ab30de4c8bbb878197))
* axgen now uses the underlying tracer provided by the ai ([36d80c8](https://github.com/24601/halligan/commit/36d80c867e33180ca528dcb4477887c25f8a522e))
* **axir:** align OpenAI realtime session.update with the current protocol ([cfac419](https://github.com/24601/halligan/commit/cfac41973da31be598c5d6c9e2ef7a30a00e16c8))
* **axir:** correct Gemini Live turn + move realtime WS-URL into Core ([1fa204e](https://github.com/24601/halligan/commit/1fa204ed26828c6981315b8e52583f33fdb56880))
* **axir:** correct program-source provenance ([f9d04cc](https://github.com/24601/halligan/commit/f9d04cceb5abdeb5111d0e845d87e53d14dc5fc7)), closes [#12](https://github.com/24601/halligan/issues/12)
* **axir:** cover failed-update rollback ([2d41b14](https://github.com/24601/halligan/commit/2d41b141e453980119f020e46ff5aec1c39e2014))
* **axir:** cover retention policy paths ([d0a42a3](https://github.com/24601/halligan/commit/d0a42a3476082ed046bfa1f4f957b707c471bba1))
* **axir:** fail codegen loud when a generated Python module lacks a helper def ([7566c74](https://github.com/24601/halligan/commit/7566c7470f26b2441440c2cc3ccb6e7400f75d41))
* **axir:** handle binary speak()/TTS responses across the non-TS ports ([5068c65](https://github.com/24601/halligan/commit/5068c65efda7558590fc42f188c3fa63648f44d2))
* **axir:** honor base_url for Rust audio transcribe()/speak() ([ba4ea67](https://github.com/24601/halligan/commit/ba4ea675d577a4ad7849b2b051a921579e7091b5))
* **axir:** implement multipart/form-data in the non-TS port HTTP layers ([57009ce](https://github.com/24601/halligan/commit/57009ceeeabfa4a2e9bc83e955c4cf85042d45d6))
* **axir:** make MCP Streamable HTTP transport SSE-aware in all 5 ports ([ed37627](https://github.com/24601/halligan/commit/ed3762769cf617193545d53d64fcabfb6b13075e))
* **axir:** mark DeepSeek structured outputs unsupported ([bdb08b7](https://github.com/24601/halligan/commit/bdb08b788f7b452f54681040e44652fdbc24e0b4))
* **axir:** playbook reflector/curator need field descriptions to learn live ([5173dfa](https://github.com/24601/halligan/commit/5173dfa1434f854ba097716c95c1691391b7cd27))
* **axir:** populate freeform json[] output fields in the language ports ([bd3a4eb](https://github.com/24601/halligan/commit/bd3a4ebacb3e5471cddabe013b72460882905a3d))
* **axir:** port agent recovery fixes to generated packages ([05a9a26](https://github.com/24601/halligan/commit/05a9a2653f6b08ad304d06ce00e90f8a5f782a2b))
* **axir:** preserve deferred ACE render contract ([87a8363](https://github.com/24601/halligan/commit/87a836330066eb6f4e3c51c745a40591cfbbfde4))
* **axir:** preserve native images in provider routing ([#597](https://github.com/24601/halligan/issues/597)) ([3751f79](https://github.com/24601/halligan/commit/3751f79eda7aa4c3c50bcf2c9a0a458661c36eed))
* **axir:** preserve structured output contracts ([73f1160](https://github.com/24601/halligan/commit/73f1160dfe467c3feda0feb1d15f3f411197a70e))
* **axir:** publish cleared backlog capabilities ([87ef028](https://github.com/24601/halligan/commit/87ef028ca533de39f27185d4d7b1b120a8d71b1c))
* **axir:** recurse into nested object/object[] flexible-json output leaves ([aa1e64a](https://github.com/24601/halligan/commit/aa1e64a51f1d0cc89969971a3cc41bffb3982c32))
* **axir:** refresh agent parity inventory ([52a26bb](https://github.com/24601/halligan/commit/52a26bb30f48566ad23bdd3ad78779a760515b2f))
* **axir:** regenerate ports for the ACE curator no-op filter ([7c299d6](https://github.com/24601/halligan/commit/7c299d6f63fe3dafcdc6c9dac012c3355170f390))
* **axir:** Rust + Go agent-API parity (AxGen-backed) + G9 public-API parity gate ([42ad3e2](https://github.com/24601/halligan/commit/42ad3e2a75c719c919238368fb9b11f7d75238e2))
* **axir:** split GPT-5.6 reasoning surfaces ([f76a950](https://github.com/24601/halligan/commit/f76a950d40fdadb0ae401445a4229157595fb43e))
* **axir:** stop the backlog gate crashing on large diffs; order open entries by landing date ([6f85dc9](https://github.com/24601/halligan/commit/6f85dc9ca057331f59baaefaf370fb113e089c58))
* **axir:** wrap forced structured-output tool_choice in a function envelope ([#585](https://github.com/24601/halligan/issues/585)) ([a7e05ed](https://github.com/24601/halligan/commit/a7e05ed2daeba734dc198b5bf5641b63425c9645)), closes [#518](https://github.com/24601/halligan/issues/518)
* Azure OpenAI chat/completion call failed ([#19](https://github.com/24601/halligan/issues/19)) ([#20](https://github.com/24601/halligan/issues/20)) ([0fad4f9](https://github.com/24601/halligan/commit/0fad4f9c3bd909c687b20193a5d0dbef4730481a))
* Azure OpenAI chat/completion call failed [#180](https://github.com/24601/halligan/issues/180) ([#181](https://github.com/24601/halligan/issues/181)) ([d3c333a](https://github.com/24601/halligan/commit/d3c333a0c26e1212ae572403d1bfacea04c31e12))
* banner fixes ([fdf453b](https://github.com/24601/halligan/commit/fdf453b1ad02c337bcd0b8c213be3802a054eb9b))
* **bedrock:** read Titan embedding dimensions from config (axir-no-impact) ([#550](https://github.com/24601/halligan/issues/550)) ([2c37bc1](https://github.com/24601/halligan/commit/2c37bc1a46552fce1cad40017c579b926d5edc85))
* big refactor and improved tooling ([e83059f](https://github.com/24601/halligan/commit/e83059f7bb695f9eb201bfcb5c4db39233265c61))
* Bind agent functions to instances for correct 'this' context" ([#61](https://github.com/24601/halligan/issues/61)) ([ce684ff](https://github.com/24601/halligan/commit/ce684ff507e6493b4bfcdae195df5da3ea362e3f))
* bind provider implementation methods to preserve context ([86c92e4](https://github.com/24601/halligan/commit/86c92e4f536cd85371ef45bd15b5f6209072adaf))
* bind ReAct replay to native protocol profile ([ac4ad87](https://github.com/24601/halligan/commit/ac4ad8723ca32a3c3447e2f4bd8da8ff0089b0e8))
* bind ReAct resume to execution authority ([3e6e67e](https://github.com/24601/halligan/commit/3e6e67e22f92c8e4f4b0f02e23022ef276861cf3))
* blank response with stream ([ab7c62d](https://github.com/24601/halligan/commit/ab7c62d52db231ae9661531f85a9d6a4cadfe222))
* bound predictor bridge metadata ([5dc0ede](https://github.com/24601/halligan/commit/5dc0edebbf2533a98a5f65f29c429166056cb5c4))
* Bubble up AxAgentClarificationError instead of logging in actorLog ([7eb3739](https://github.com/24601/halligan/commit/7eb3739afd399f77abd1af0901720685afd14ada))
* bug in new open ai chat model ([654282d](https://github.com/24601/halligan/commit/654282d15c98d617840dc6f6014d0e961393bcd2))
* bug in traces, missing input values ([d8a8ee5](https://github.com/24601/halligan/commit/d8a8ee5544214c30a1ac341b7c11fb9fd717a57b))
* bug with embed model selection ([7ba9f4d](https://github.com/24601/halligan/commit/7ba9f4de5b61877131dc747a97c0b0038883afec))
* bug with exporting enums ([4fc0a3b](https://github.com/24601/halligan/commit/4fc0a3b5a7dd5413d8f6d4d3cfe18d2af54941c6))
* bug with exporting enums ([4ca8c5d](https://github.com/24601/halligan/commit/4ca8c5d23ec5b7320cc78936b3a663920ae6946c))
* buid issues ([571b775](https://github.com/24601/halligan/commit/571b7755246576566de406c28cd3f74d9effcf78))
* build error ([e4d29c3](https://github.com/24601/halligan/commit/e4d29c34297c31bfe91def1af3468e6566554ce2))
* build fix ([617a48b](https://github.com/24601/halligan/commit/617a48bf32dd75eddfe5f35327bc3616b94208a6))
* build fix ([7286042](https://github.com/24601/halligan/commit/7286042c3ba6b56a1fc67bc98c77a8f85c195b31))
* build fix ([eb4b08b](https://github.com/24601/halligan/commit/eb4b08bc75b5bdaaf12708d2c48f3f0ece862b3f))
* build fix ([e5000fa](https://github.com/24601/halligan/commit/e5000fa0728f18957b70d0b74655dcf6aa4671c9))
* build fixes ([b19e90a](https://github.com/24601/halligan/commit/b19e90abfbfe5ef95455a5cc899346aec0333c83))
* build fixes ([81809a4](https://github.com/24601/halligan/commit/81809a4129cd0508b9740ae7a382413445edd79e))
* build fixes ([e24f197](https://github.com/24601/halligan/commit/e24f197a37e521d91a952e0b4e7fbd4a87d2a8da))
* build fixes ([d8d4a47](https://github.com/24601/halligan/commit/d8d4a478e70ddfbff785d123f19ff78946f97789))
* build issue ([71b5ae8](https://github.com/24601/halligan/commit/71b5ae85f7caa77ee24d051f4d9c0b8a01fcb77c))
* build issue ([5915507](https://github.com/24601/halligan/commit/5915507ac085a15a15db6928039c7cf51d9dd89e))
* build issue ([879ef38](https://github.com/24601/halligan/commit/879ef381693ba0e62eaf9d8fbec28477ff0c582d))
* build issue ([201d331](https://github.com/24601/halligan/commit/201d33126c69dca4907101fab974d6e5e6ba42fd))
* build issue ([fee21e2](https://github.com/24601/halligan/commit/fee21e23a04c779bcd10d43581d12df2510d6bcc))
* build issue ([f7687ee](https://github.com/24601/halligan/commit/f7687ee3bbd0bd675787d9747a253ec701b3d330))
* build issue ([079b792](https://github.com/24601/halligan/commit/079b7927d53e97599844f5e914648c5e0d059856))
* build issue ([a25286a](https://github.com/24601/halligan/commit/a25286a6b4ed33aaeec4d6fda7eb0fd117fe8e0d))
* build issue ([47f78d6](https://github.com/24601/halligan/commit/47f78d634f56376419a2f218f828c83b87db7f1d))
* build issue ([ceae901](https://github.com/24601/halligan/commit/ceae90111b915f1e45b4d1d2c5447bb6bff5ede6))
* build issue ([7733463](https://github.com/24601/halligan/commit/773346339acec1c7f7f9640cdf183b92fee28615))
* build issue ([071f476](https://github.com/24601/halligan/commit/071f476fe8046b561f54786e364517cf52fc91cb))
* build issue with previous version ([cfe92fd](https://github.com/24601/halligan/commit/cfe92fdbe5a2205815da3978a6c9903dcc46b617))
* build issues ([3fa583c](https://github.com/24601/halligan/commit/3fa583c49aa6358a6f27f1eb91b08ef10602d0cf))
* build issues ([51188ac](https://github.com/24601/halligan/commit/51188acdd6df1a2b7afa12dc6e002a01b3eed4c5))
* build issues ([169f4cc](https://github.com/24601/halligan/commit/169f4cc23a167715cfc072a562058ea167174989))
* build issues ([69871d7](https://github.com/24601/halligan/commit/69871d745a7d1988907368de7df02a8a72fc98d1))
* build issues ([e574f3a](https://github.com/24601/halligan/commit/e574f3ae1f9c7e4e6aa9291f3909a33744dfc5a4))
* build issues ([dd346c4](https://github.com/24601/halligan/commit/dd346c4b03aa43b2725ca3da40bab522ffb9297f))
* build issues ([33394df](https://github.com/24601/halligan/commit/33394dfd250e5c0f16bf9baa5c2b23d4d1777ef8))
* bump the academy page lockstep count in the website link checker ([25ebc12](https://github.com/24601/halligan/commit/25ebc128a1279e29d8bb0554885ee421c2efcfab))
* capture authority inputs atomically ([57633cc](https://github.com/24601/halligan/commit/57633cc1cbbac2517a1952fd5f2a4b15fff49cb9))
* card layout fix ([7c7e59c](https://github.com/24601/halligan/commit/7c7e59c5ee64156f5f3e9a1700484fea2db85511))
* change name in package ([9697d19](https://github.com/24601/halligan/commit/9697d190526bfd923baa244aacd8e7522845a340))
* ci failure ([#96](https://github.com/24601/halligan/issues/96)) ([ba835f4](https://github.com/24601/halligan/commit/ba835f4620b1a79367cc7706aa7b5539c0517f49))
* **ci:** add adaptive routing spelling terms ([59ac880](https://github.com/24601/halligan/commit/59ac880d2d851257ba1ae3c1ce295c1592e5ebfd))
* **ci:** honor AxIR non-portable exemptions ([#596](https://github.com/24601/halligan/issues/596)) ([f0f155c](https://github.com/24601/halligan/commit/f0f155c0b14d4340770d26ec6a51c6e6f8321298))
* **ci:** recognize provider kwargs term ([97c1032](https://github.com/24601/halligan/commit/97c10320462a77f5e4b6b7b7b73b448f361078b1))
* **ci:** remove stale contribution policy test ([fa3fc88](https://github.com/24601/halligan/commit/fa3fc88984fc93c4cb210418f2a16604ef21c413))
* clarify Ax Academy headline ([790637c](https://github.com/24601/halligan/commit/790637c40898beeb44f395b4b390941b865bfbef))
* classify authority agent inventory ([b28b6b1](https://github.com/24601/halligan/commit/b28b6b12516b430608f49f41b2ce5ad078e6f383))
* clean up code formatting and improve consistency in examples ([f4af653](https://github.com/24601/halligan/commit/f4af653a737b7c0532c0e7d06066c6c5bfcb045e))
* Clean up extraneous files and revert package.json changes ([#257](https://github.com/24601/halligan/issues/257)) ([4866c07](https://github.com/24601/halligan/commit/4866c074fc953a661fbed8873bce5111a3e3d5e3))
* cleanup ([e005c68](https://github.com/24601/halligan/commit/e005c681652036ddd04075f2c3ca9ba372525f55))
* cleaup gitignore ([6627ff3](https://github.com/24601/halligan/commit/6627ff315aacddcfd321d014f7d129cd20142655))
* close authority runtime bypasses ([b6cc074](https://github.com/24601/halligan/commit/b6cc07483918e520c3be28e19fd792df5d427059))
* cohere and gemini function calling ([a839c04](https://github.com/24601/halligan/commit/a839c0489809fe3e2abc871fcb6ff4912d8d0b11))
* common llm model config to ensure more deterministic outputs ([0dce599](https://github.com/24601/halligan/commit/0dce59998bc731153a5d3588245e8fbfb7635727))
* correct Claude 4.5 Haiku model name in Vertex enum ([#474](https://github.com/24601/halligan/issues/474)) ([24f8e40](https://github.com/24601/halligan/commit/24f8e40b447ed07b7b06839cd20e0aabaf5a970b))
* correct spelling of 'showThoughts' in model configurations ([35eeff7](https://github.com/24601/halligan/commit/35eeff77ad0f02b5a04026cd841478c7df5e9816))
* correct temperature property in self-tuning schema generation ([59efdb3](https://github.com/24601/halligan/commit/59efdb34d1bd8b0e06528399390d34ec4c65741d))
* corrected embeddings endpoint ([#51](https://github.com/24601/halligan/issues/51)) ([d1a733e](https://github.com/24601/halligan/commit/d1a733e632d0dbd3f77f31e79e784b016c0e8844))
* cover authority AxIR backlog paths ([f0fa656](https://github.com/24601/halligan/commit/f0fa65647420bf99db471911dd8e1a46c0a9605e))
* date time with seconds support ([abae15e](https://github.com/24601/halligan/commit/abae15eeb5fcaac38b046ee75e453771eec63ef6))
* debug logs ([7939cde](https://github.com/24601/halligan/commit/7939cde6d82a42c79daa8197d27c2f25140c636b))
* deepseek r1 on together.ai returning empty result ([#128](https://github.com/24601/halligan/issues/128)) ([250ed54](https://github.com/24601/halligan/commit/250ed54e9d7e0d1f40aa5cc8b58e684badd4583d))
* **deepseek:** advertise unsupported structured outputs ([36dc421](https://github.com/24601/halligan/commit/36dc4218053864e0cfe2e9050860719b352c9c50))
* deno webworker fixes ([b4f9538](https://github.com/24601/halligan/commit/b4f9538920c6da4d604efb225e83a384cc98b3dc))
* doc build fix ([b6c110b](https://github.com/24601/halligan/commit/b6c110b151c78b2096b21b4ec32f573796a3b9de))
* **docs:** make the subsystem-s mermaid example's class field output-only ([6b68661](https://github.com/24601/halligan/commit/6b6866147922076f09776de4f32fd9132a126f35))
* **docs:** remove deleted llmQueryPromptMode field; add typecheck to CI ([947fcdf](https://github.com/24601/halligan/commit/947fcdf3cdf07687eebde5ad9f00348749cc3d79))
* don't fail validation on missing optional field ([#94](https://github.com/24601/halligan/issues/94)) ([432f8fc](https://github.com/24601/halligan/commit/432f8fc53980a2316a0b0953cff4811592641ff0))
* don't render extraneous period at the end of task prompt ([#111](https://github.com/24601/halligan/issues/111)) ([3c30c47](https://github.com/24601/halligan/commit/3c30c47d06c1f5dbcb425eb840166d436e9ac709))
* don't swallow error in AxBalancer ([#118](https://github.com/24601/halligan/issues/118)) ([aa25c7a](https://github.com/24601/halligan/commit/aa25c7a3afc2f71af8537ddb2425633d693e43c0))
* don't throw on bare object schemas in Anthropic tool parameters ([#494](https://github.com/24601/halligan/issues/494)) ([c7a4ecc](https://github.com/24601/halligan/commit/c7a4ecc2df294bf929fbb16a01febe9b68d5db77))
* **dsp:** AxACE must not let undefined option values clobber defaults ([f37b44a](https://github.com/24601/halligan/commit/f37b44a75322be3dd53b2def7fc31f7a497006eb))
* **dsp:** correctly extract instruction from signature in GEPA optimizer ([#466](https://github.com/24601/halligan/issues/466)) ([76e7a6c](https://github.com/24601/halligan/commit/76e7a6ce5d4c76bc210a996318a3f28678e9262c)), closes [#463](https://github.com/24601/halligan/issues/463)
* **dsp:** drop no-op acknowledgment bullets from the ACE curator ([be3382c](https://github.com/24601/halligan/commit/be3382c57b308f7ee84f873e16bf6b6709219b0d))
* embedding requests on Google Vertex API ([#107](https://github.com/24601/halligan/issues/107)) ([25282f6](https://github.com/24601/halligan/commit/25282f6277e1f5d52aceebd86503256d19218b6d))
* Empty Function Calls Handling [#254](https://github.com/24601/halligan/issues/254) ([0eebda0](https://github.com/24601/halligan/commit/0eebda0a3224790199b57668d419e4c194c6538b))
* enable custom API URL configuration for OpenAI provider ([#299](https://github.com/24601/halligan/issues/299)) ([edbb8f4](https://github.com/24601/halligan/commit/edbb8f46f87ff79752e446dc55aa1c339046bb10)), closes [#297](https://github.com/24601/halligan/issues/297)
* enforce Academy question API coverage ([fd7dcb0](https://github.com/24601/halligan/commit/fd7dcb0c1e11415b3340b7fe2ca7b925d69f79be))
* enforce model-specific thinking params and default temp for Gemini 3+ ([00b181d](https://github.com/24601/halligan/commit/00b181ddd320cf143c0b6e1e431c579f14a8782c))
* enhance debug parameter handling in response processing ([0d36063](https://github.com/24601/halligan/commit/0d36063386241dc5626dc96a8c2179e0f5721f4c))
* enhance error handling in AxGen class ([aa76a28](https://github.com/24601/halligan/commit/aa76a28d8a77b933acce9ef1a075ce5b5027d37a))
* enhance memory tag validation and retry logic in tests ([adecf29](https://github.com/24601/halligan/commit/adecf29904f8df5d634f6eedbca1ad7c6927e56f))
* enhance type handling in NotebookCell and TypeDropdown components ([38d6ed9](https://github.com/24601/halligan/commit/38d6ed9027a1d2a13bd1aabd807ebc4f263105a9))
* ensure Gemini 3+ minimum temperature of 1.0 is actually applied ([57c8edd](https://github.com/24601/halligan/commit/57c8edd363f00baa97f9a1df7b62de0f5400edd4))
* ensure streaming partial memory blocks only merge with other partial blocks, otherwise append as new. ([5679412](https://github.com/24601/halligan/commit/5679412a2961c5acd51675fa20ddb9f8c9f03c33))
* Ensure token usage is consistently included in traces ([#207](https://github.com/24601/halligan/issues/207)) ([9721640](https://github.com/24601/halligan/commit/97216403626ca84c3afc1eb2522cac0261d183e9))
* evalUtils missing from exports in index.ts ([#173](https://github.com/24601/halligan/issues/173)) ([b103f41](https://github.com/24601/halligan/commit/b103f41aa8726175ca7a87a78d925bcd1bac06b9))
* **event:** abort authority resolution without leaking activeRuns ([d60ad9d](https://github.com/24601/halligan/commit/d60ad9d4126e6d4a94576895275c035ff0d16dcd))
* **event:** abort live sources and reject start during close ([6eff1d6](https://github.com/24601/halligan/commit/6eff1d6b6e23e9107b07c3cbc4b4e5b23e34e213))
* **event:** abort verifier child install after accepted cancel ([2ab6fdf](https://github.com/24601/halligan/commit/2ab6fdf6d257216ddac28d214e38ff24f580fd4f))
* **event:** bound demand latency metrics ([9f63e6e](https://github.com/24601/halligan/commit/9f63e6e504b2d0a57a8b7c0f86d81d949bea2f17))
* **event:** bound timeline deserialization ([711a216](https://github.com/24601/halligan/commit/711a216036ca96c99b64110a8e42f671244edfe2))
* **event:** close demand boundary audit findings ([618b63c](https://github.com/24601/halligan/commit/618b63c9b3931c50dd5972d5502a95a7adfe6101))
* **event:** close demand lookup and restore gaps ([bd23086](https://github.com/24601/halligan/commit/bd230861b869e1447b30b96f5aace5861c0d2bbe))
* **event:** close final timeline audit ([7ec3553](https://github.com/24601/halligan/commit/7ec355326bea922f3d0ab1e437fc0150fc2d7d1b))
* **event:** close recovery mutation gaps ([091633f](https://github.com/24601/halligan/commit/091633feda105eec71ad7c0712d949fbe5b9e0a5))
* **event:** close remaining recovery findings ([376d077](https://github.com/24601/halligan/commit/376d077072747201553cc7ca366da059bfe4b352))
* **event:** close timeline review findings ([a83c941](https://github.com/24601/halligan/commit/a83c941bb5813cb6ed7bc0cc3022ddd8057ac412))
* **event:** compact verifier journals to commitments ([98e1099](https://github.com/24601/halligan/commit/98e1099827933f92a06ac903723d3218bcf9eadf))
* **event:** complete runtime landing repair ([4771325](https://github.com/24601/halligan/commit/47713253fd742e849d6c13b05e12b83fb9b31509))
* **event:** constrain payload stage states ([265b7e0](https://github.com/24601/halligan/commit/265b7e0801ddf5e498c15e9a93aa2752afd62700))
* **event:** fence continuation admission and shutdown ([bafcd1c](https://github.com/24601/halligan/commit/bafcd1cf9617791f15749f2154965d4039e32398))
* **event:** fence sink effect finalization ([caaaf7d](https://github.com/24601/halligan/commit/caaaf7d5537d55613a6f95715316d6f571b77937))
* **event:** fence staged output recovery ([6f254e1](https://github.com/24601/halligan/commit/6f254e197704a78cd789a7d92cad7b9d811052de))
* **event:** fence uncertain component ownership ([f482835](https://github.com/24601/halligan/commit/f482835ee074e15511b31d6dac686fefd3f8e2b0))
* **event:** fence uncertain replacement dependencies ([d38e000](https://github.com/24601/halligan/commit/d38e00095dedc254cc8a07b623be2128b98e36c6))
* **event:** harden advisory demand boundary ([13417b1](https://github.com/24601/halligan/commit/13417b132f47207b063a7ec8eb4d47961b3024e2))
* **event:** harden effect durability boundaries ([ecf923e](https://github.com/24601/halligan/commit/ecf923ea31d79c03ca6ce79a8564ceb48dad598e))
* **event:** harden timeline input validation ([54f495a](https://github.com/24601/halligan/commit/54f495a4ee1945f6bf1f0fc02e0276ff8af26539))
* **event:** harden transactional lifecycle boundaries ([a839a80](https://github.com/24601/halligan/commit/a839a80919f1b2ee806763a60ca1d1ba5c775e84))
* **event:** isolate deserialization from prototypes ([5a00295](https://github.com/24601/halligan/commit/5a00295fde8f7caf02c7e32a424fcb04da624c1c))
* **event:** isolate timeline snapshots from prototypes ([581b8ef](https://github.com/24601/halligan/commit/581b8ef33d72fc0bb03a5959c802d548f30aa233))
* **event:** journal verifier transition operations ([d32a717](https://github.com/24601/halligan/commit/d32a717ee0f2fb7bc60869ab4cb1149a1ca63143))
* **event:** keep cancelled demand observations from becoming retained ([4bee5e8](https://github.com/24601/halligan/commit/4bee5e8a85763ce51a13e175e2d06d880f907926))
* **event:** keep timeline frontiers monotonic after eviction ([2c94f95](https://github.com/24601/halligan/commit/2c94f959185283d758f13c21f5f9d17188821fea))
* **event:** make demand append cancellation atomic ([5056b4a](https://github.com/24601/halligan/commit/5056b4aadc44b023cf256928df6d163630ab1938))
* **event:** make verifier handoffs crash-consistent ([30f3eea](https://github.com/24601/halligan/commit/30f3eea554c03d39edaa27a372ba95da20eb76c9))
* **event:** make verifier transitions validate-then-commit ([2bb885d](https://github.com/24601/halligan/commit/2bb885da448152b7ec87a98581ac6ce45699ea05))
* **event:** preflight inert snapshot graphs ([9d59bbf](https://github.com/24601/halligan/commit/9d59bbff348d48daee294d8a7d405ad89f9556fc))
* **event:** preserve resume admission on recovery ([0115443](https://github.com/24601/halligan/commit/0115443dd5158b4883b20754784ec184f416106f))
* **event:** quarantine unresolved payload stages ([2be96e3](https://github.com/24601/halligan/commit/2be96e3d8dadc4c85efee220dd818c617de16abe))
* **event:** reconcile later effects and keep in-flight settled rows ([1138f8d](https://github.com/24601/halligan/commit/1138f8d994277d4f753d1b169405d74fed55e7bc))
* **event:** reject cancelled verifier transition after digest awaits ([549d4f0](https://github.com/24601/halligan/commit/549d4f08d9e1142c765878b85f3cf123c90e0a1d))
* **event:** rename redrive controller map for spelling ([fa13b27](https://github.com/24601/halligan/commit/fa13b27e0b68be9f5c4da15bcf4280e1bccfecc4))
* **event:** require settled effects before completion ([346450a](https://github.com/24601/halligan/commit/346450aa4d34572ae520f65ff4893191164aafde))
* **event:** retain and scope verifier confirmations ([1bfe22b](https://github.com/24601/halligan/commit/1bfe22bf2178093fd86bb2ddcab8b678acd21e1c))
* **event:** retain callback byte reservations ([f167945](https://github.com/24601/halligan/commit/f167945ef2f182849b06ac8ea2f38c73b5079b9f))
* **event:** retain callback capacity reservations ([203eb7b](https://github.com/24601/halligan/commit/203eb7bf723d8696ba0e3e56cedce927dcdacd98))
* **event:** serialize same-id redrive and share close quiescence ([5803919](https://github.com/24601/halligan/commit/580391988379e4830cec7ec5ad66a740e1836015))
* **event:** snapshot demand inputs once ([8495c65](https://github.com/24601/halligan/commit/8495c65276c69b351a6f756fbd05c698297f6e0e))
* **event:** snapshot detector identity once ([e9ad5d1](https://github.com/24601/halligan/commit/e9ad5d1d44d537ca9e199cfa8facd7f49eecb414))
* **event:** validate effects after recovered sinks ([16828d7](https://github.com/24601/halligan/commit/16828d777c8dd2b669c7f0062200b7bf7817a448))
* **event:** verify persisted child commitments ([857550b](https://github.com/24601/halligan/commit/857550b1da4843a159f2e37f914dbe54a0c63a8e))
* examples ([973eb51](https://github.com/24601/halligan/commit/973eb51a23e0a6b4042d37b0e9967de2c0a76234))
* **examples:** remove deleted recursionOptions.maxDepth, fix functions shape ([a1b65c8](https://github.com/24601/halligan/commit/a1b65c84413f784fdd70a1ca5233f9611d66c92d))
* **examples:** repair CI type checks ([d42d379](https://github.com/24601/halligan/commit/d42d379d0bb722c5602d5baa726b6dfb66589ef0))
* Export hugging face data Loader and fix summarize example ([#32](https://github.com/24601/halligan/issues/32)) ([a77f46a](https://github.com/24601/halligan/commit/a77f46ad5c06e76b0a30eb807e444ff5822b4d93))
* extended error messages ([140e50c](https://github.com/24601/halligan/commit/140e50cb063596d1b673034f8af58c36dad94b9b))
* extra comma in package.json ([16b36f5](https://github.com/24601/halligan/commit/16b36f507e9b9e4cde6a823cb0f844f4ec0b3ee1))
* fail closed on malformed playbook evidence ([e1b32f0](https://github.com/24601/halligan/commit/e1b32f07c1af4c2067822879369d332e436f7cbf))
* field extraction issue ([9d4a083](https://github.com/24601/halligan/commit/9d4a083af3b845b057294badc096685fb781ed27))
* file path issue in ax build ([3264a11](https://github.com/24601/halligan/commit/3264a11387272387efeb029872b5406156ea3fa4))
* fix in proxy ([f778c9d](https://github.com/24601/halligan/commit/f778c9d2a8337730bc4ab08a0b00e304758d2500))
* fix in proxy ([f007d26](https://github.com/24601/halligan/commit/f007d269abd3768954d9e3428fe81e2ab2110b1c))
* fix in proxy ([ab87118](https://github.com/24601/halligan/commit/ab87118222de01ae4409aa5aaa65cdaa81eaf526))
* **flow/planner:** update regex for block splitting to handle whitespace correctly ([7e8ad09](https://github.com/24601/halligan/commit/7e8ad09ff599c8660f0754c4b71c28bee2026774))
* **flow:** see through branch/while steps in signature inference ([d4b5246](https://github.com/24601/halligan/commit/d4b524635e22b6ee00d91dfee491dcec23025fb3))
* functions are optional for agents ([13f6251](https://github.com/24601/halligan/commit/13f625188c51c2cac208ce391cc771414e4471b3))
* gemini 3.1 pro vertex fixes ([979383d](https://github.com/24601/halligan/commit/979383d9cb5cfff4cdb2d73b7fb93c3b0067fa80))
* gemini batch embed endpoint ([4ebad97](https://github.com/24601/halligan/commit/4ebad972fc7e9bef96ba20b707ab836aa2f2b73f))
* gemini embedding response fix ([6f93b0b](https://github.com/24601/halligan/commit/6f93b0bd5ad171768123898925d49ddc64b3ff06))
* gemini flash function calling issue ([6480d2c](https://github.com/24601/halligan/commit/6480d2c450f96b77b8fbb30815cc375a49875168))
* gemini function calling ([df0237d](https://github.com/24601/halligan/commit/df0237dda0b9f66a25ef80d1b78849eb68e6f0ea))
* gemini function calling issues ([ad865d7](https://github.com/24601/halligan/commit/ad865d74c1b95e8d61a3bc5c259924867eb9c1e0))
* gemini non-streaming endpoint fix ([11179ad](https://github.com/24601/halligan/commit/11179ad312989b56b79c9144527e5e8371a1c281))
* **gemini:** default Vertex Gemini to v1 and harden streaming ([#511](https://github.com/24601/halligan/issues/511)) ([8ee4c3e](https://github.com/24601/halligan/commit/8ee4c3e578669a8570d857aed7b12de2b74dc05b))
* **gepa:** align lineage scalar with acceptance ([bab0e06](https://github.com/24601/halligan/commit/bab0e065962f9f2f4b252ab95bbb58ae3358ea12))
* **gepa:** harden lineage fingerprints, trim, and CI timing ([b8a0794](https://github.com/24601/halligan/commit/b8a07946ee96b4bc74a1e8b85d48f9d783d9a46d))
* **gepa:** keep default-policy dummy examples unless maxExamples is 0 ([892bd1c](https://github.com/24601/halligan/commit/892bd1c7577b47a6d6490e5a09e878bbee7fa0c7))
* **gepa:** keep explicit structured scalars on adapter and ACE paths ([24f9963](https://github.com/24601/halligan/commit/24f9963eac8b726f4e5aeb376488c95da710c80f))
* **gepa:** keep omitted lineage flag in checkpoint optimizerState ([28a9abb](https://github.com/24601/halligan/commit/28a9abb8f0db67360db47407bff7ce8264a17e2d))
* **gepa:** let built-in maxExamples 0 reach the teacher ([3fd3675](https://github.com/24601/halligan/commit/3fd3675367a70161437f6ad7835a3bb05d5430aa))
* **gepa:** normalize failed objective vectors after batch ([b5cd02a](https://github.com/24601/halligan/commit/b5cd02a1a5b80ec9f9b0b70ac6739a7149d5bcc8))
* **gepa:** prefer an accepted evolution over the seed it ties ([#546](https://github.com/24601/halligan/issues/546)) ([f260976](https://github.com/24601/halligan/commit/f260976a83d2e1dccb7f5e4a13caac3fa243d934))
* **gepa:** preserve lineage integrity across aborts ([1d235f2](https://github.com/24601/halligan/commit/1d235f2ae1eed4e5776732c04848ccac6aba4e94))
* **gepa:** publish lineage decisions only after validation ([977356d](https://github.com/24601/halligan/commit/977356d5dbcfed746b135f018655ed3b9acd3850))
* **gepa:** restore default proposal retries and adapter guards ([82d4bb1](https://github.com/24601/halligan/commit/82d4bb122cf7a66ca346b2cf115a46e31317ecb9))
* **go/goja:** surface console output to the actor as per-turn logs ([#602](https://github.com/24601/halligan/issues/602)) ([e8b2618](https://github.com/24601/halligan/commit/e8b261853617a203a540c595e2408105785614ad))
* **go/goja:** truncate an oversized log line instead of deleting it ([#604](https://github.com/24601/halligan/issues/604)) ([736ae2b](https://github.com/24601/halligan/commit/736ae2b9f1a3d14572a357133294b046635aff72)), closes [#602](https://github.com/24601/halligan/issues/602) [#602](https://github.com/24601/halligan/issues/602)
* google gemini function calling ([a9214f3](https://github.com/24601/halligan/commit/a9214f3e6d2d96b724734e7a128276cbb76ca24d))
* google gemini function calling fix ([45fe357](https://github.com/24601/halligan/commit/45fe357c3ee5e69ee59cdb67b9153ac581343990))
* google gemini now works great ([a6d6528](https://github.com/24601/halligan/commit/a6d6528e5f4a3a66be991ef8395159fb66bad1b8))
* **google-gemini:** align Google Maps grounding types/options and retrievalConfig with Gemini api ([#393](https://github.com/24601/halligan/issues/393)) ([b44f534](https://github.com/24601/halligan/commit/b44f5340a603475728179e75baa7415767eec1e9))
* **google-gemini:** correct Vertex cachedContents URL and model resource ([#513](https://github.com/24601/halligan/issues/513)) ([f2c39e5](https://github.com/24601/halligan/commit/f2c39e52239b863e9d2526a619c8e020c17f5c5a))
* **google-gemini:** implement missing googleSearch option ([#221](https://github.com/24601/halligan/issues/221)) ([414a89f](https://github.com/24601/halligan/commit/414a89fd06f904e8de13986ccbecc0c07a5214aa))
* handle DataCloneError in JS runtime worker message passing ([8f54922](https://github.com/24601/halligan/commit/8f54922d04b4ef8cae809a6fa1a0eae54a2836c3))
* handle numeric zero values in prompt field rendering ([#382](https://github.com/24601/halligan/issues/382)) ([d06849c](https://github.com/24601/halligan/commit/d06849c70c1cc2d61f5ab82c435fbbc3b027e190))
* handle read-only global properties in Deno worker scope ([f2ae6a8](https://github.com/24601/halligan/commit/f2ae6a875fd585f28ae6fa00eaca6279a2851cfc))
* Hardcode error class names to prevent minification issues ([#421](https://github.com/24601/halligan/issues/421)) ([5267340](https://github.com/24601/halligan/commit/5267340459564a576b6f1c9fddff785588e78af5))
* harden program-source execution boundaries ([0d7e6f8](https://github.com/24601/halligan/commit/0d7e6f8191ac534d5ad7cb7423e9cbca35ab46db))
* import issues ([ce87294](https://github.com/24601/halligan/commit/ce87294cb62e293c6186a922b2a179bcde25baf1))
* improve code formatting and cleanup in tests and base AI implementation ([eba5f39](https://github.com/24601/halligan/commit/eba5f393f1c397dba7848992fefa8157e8cd3531))
* improve examples ([6e656cb](https://github.com/24601/halligan/commit/6e656cbe631ff8eb127aae49e799a77cc55cecfb))
* improve token budget handling and update model references ([6868de6](https://github.com/24601/halligan/commit/6868de61805bd42d8c04f39a65edd72363a29cad))
* improved ax generate error ([bebf924](https://github.com/24601/halligan/commit/bebf924d42f753e3d21c7a72cab4822f0464c5af))
* improved model matching for info search ([5c8c8e3](https://github.com/24601/halligan/commit/5c8c8e3d5c325872ca2217c813f224394273ce6a))
* improved the customer suppot example ([103b072](https://github.com/24601/halligan/commit/103b072c241140e380b0695d2c8fbaf5a91d3966))
* include cache_control for string-typed user messages ([#478](https://github.com/24601/halligan/issues/478)) ([84aa908](https://github.com/24601/halligan/commit/84aa908c30ef0f5ceebe25e131e1efe479a9fed2))
* increased tests timeout ([4d35f06](https://github.com/24601/halligan/commit/4d35f06ddbaabf1713a4b799fc3a8af41416ab1c))
* input fields type image rejected [#33](https://github.com/24601/halligan/issues/33) ([#34](https://github.com/24601/halligan/issues/34)) ([4932b1f](https://github.com/24601/halligan/commit/4932b1f641b0ae9392bb70e1703fe402881f1488))
* issue with agent set description ([7c9af34](https://github.com/24601/halligan/commit/7c9af34276ac527f0fe8bbaa3994690ca7b335d9))
* issue with anthropic models streaming random text before function calls causing our early fail to trigger breaking things ([f49197c](https://github.com/24601/halligan/commit/f49197cf1cb2ca3c843754ae5599fd0aee8f9687))
* issue with cspell ([806cba1](https://github.com/24601/halligan/commit/806cba130fe61f96f8629d8d44344c80306c0611))
* issue with doc:build ([a504956](https://github.com/24601/halligan/commit/a504956bbd7c3569dea49393d9f007b6ec917232))
* issue with function results ([9f54a8b](https://github.com/24601/halligan/commit/9f54a8b686376baea108ca9873672425ed8ad10e))
* issue with model map feature ([d33d9be](https://github.com/24601/halligan/commit/d33d9be6fe3da6d1e38213f5203746952a7790b1))
* issue with rate limiter ([0648ad7](https://github.com/24601/halligan/commit/0648ad7263493ebc34492cd72ec20704971c088f))
* issue with require function call in multi step axgen ([f652785](https://github.com/24601/halligan/commit/f6527850dd3a7a97f86fd284ea166af0dc41e94d))
* issues with prompt tuning ([122dc2d](https://github.com/24601/halligan/commit/122dc2df3e328b86a36ca464a19e9b0fd9df20b4))
* json5 build issue ([fe6de9c](https://github.com/24601/halligan/commit/fe6de9ce995bc51996b12db57d9f3787bda2abd9))
* log originating error in balancer ([#385](https://github.com/24601/halligan/issues/385)) ([70ca5e5](https://github.com/24601/halligan/commit/70ca5e563f706a00d9a858dbdae5f4b047b94c8f))
* major fix for issue with streaming deltas ([91f5253](https://github.com/24601/halligan/commit/91f5253e8f00a2b51b867401a5f823546a21aea9))
* major fixes to function calling ([d44a373](https://github.com/24601/halligan/commit/d44a37300f4c427ede9a803939f5b90430e17a30))
* make llm use batch functions ([a5d694e](https://github.com/24601/halligan/commit/a5d694e86fc8bd7a7d159f3775858806dc5f68b3))
* make mistral function calling work ([6bd9cf7](https://github.com/24601/halligan/commit/6bd9cf78b72ddd1b190ab798b47aedeb9a888001))
* make ReAct replay digest fail closed ([9d6eb4d](https://github.com/24601/halligan/commit/9d6eb4d1600b8abe9183f8f3339ed4a4bb967888))
* make RLM interpreter returns less brittle ([6d0b314](https://github.com/24601/halligan/commit/6d0b314b59597508140d6465fa011a694fa9bd34))
* make stop sequence optional ([d18addc](https://github.com/24601/halligan/commit/d18addcd287ce17dcd2a2c5feb8b8917d4f4f0e3))
* malformed response [#191](https://github.com/24601/halligan/issues/191) ([8728eed](https://github.com/24601/halligan/commit/8728eed42ef16bef94dfc28062c62c283016d328))
* **maven:** bump central-publishing-maven-plugin 0.7.0 -> 0.11.0 ([#554](https://github.com/24601/halligan/issues/554)) ([2e0b667](https://github.com/24601/halligan/commit/2e0b667832554d3f299244d421c41ccfd1f945f8))
* mcp init issue ([00a732c](https://github.com/24601/halligan/commit/00a732c4a765e6cca7e27ade3658c93c83315c6a))
* **mcp:** validate subscription acknowledgements ([42377de](https://github.com/24601/halligan/commit/42377de43c399892593864dd86bd43c4eec3cee4))
* **metrics:** accurate estimated cost metric for all request types ([#508](https://github.com/24601/halligan/issues/508)) ([07f2ba7](https://github.com/24601/halligan/commit/07f2ba7598fa7f43e9a50ca3a2db807e5fb0498d))
* **metrics:** use shared model name normalization for cost and config lookups ([#509](https://github.com/24601/halligan/issues/509)) ([5e885af](https://github.com/24601/halligan/commit/5e885af49aa3d853211a1fbc681fe6beacbc86ca))
* Migrate from nested `rlm` object to top-level properties for context fields, runtime, and other options across multiple agents and examples. Update documentation and examples to reflect the new structure, ensuring clarity in agent definitions and improving consistency in code organization. ([3c55e1c](https://github.com/24601/halligan/commit/3c55e1c6210333d04bde44659dbe32bfda971f5f))
* migrate npm package to llmclient ([97a4a07](https://github.com/24601/halligan/commit/97a4a07ed8e614563c7b7100141ce8bfde6aedb9))
* minor ([ef0cda2](https://github.com/24601/halligan/commit/ef0cda2c6fcdf4b7d11af7f33d9f71a9d2d91ef8))
* minor build fix ([32f04b3](https://github.com/24601/halligan/commit/32f04b3e5174a4915d8099c4a32c41979b0c652b))
* minor fix ([0bd2c54](https://github.com/24601/halligan/commit/0bd2c547dce6fe6f34df36035718573e7a3811ef))
* minor fix ([ca42387](https://github.com/24601/halligan/commit/ca42387b8ffcc6359cf433ab761d8dc202de07d5))
* minor fix ([62fbf38](https://github.com/24601/halligan/commit/62fbf3807d60e1e367560a08ee40c25b9081137b))
* minor fixes ([e5f6f15](https://github.com/24601/halligan/commit/e5f6f151bd42a5b58e84d6d84266737c0f3a960a))
* minor fixes ([a86e6fe](https://github.com/24601/halligan/commit/a86e6fe280c9cc31792a1bfa4d0c89c220b5001c))
* minor fixes ([3792700](https://github.com/24601/halligan/commit/3792700363172567b836cb5c562a62c41a703ce4))
* minor fixes ([574f73f](https://github.com/24601/halligan/commit/574f73f715f8972dbefa73e09978abf2de8e562c))
* minor fixes ([5ebf283](https://github.com/24601/halligan/commit/5ebf2831a8ecfef56df775ca127c546f0a562516))
* minor fixes ([5bb612d](https://github.com/24601/halligan/commit/5bb612d45a3089d8dac338a2cc8a21d388c161f9))
* minor fixes ([0fa4687](https://github.com/24601/halligan/commit/0fa4687ea70113321c829e9950e5b136da2e830d))
* minor fixes ([47eef31](https://github.com/24601/halligan/commit/47eef314ab5227940700938b08cfdbf39e390a7a))
* minor fixes ([0da9daf](https://github.com/24601/halligan/commit/0da9dafeb6375bdc819b1b0023253bf321f2ff07))
* minor fixes ([15bd72f](https://github.com/24601/halligan/commit/15bd72f9c8fff5b461792076f91e9689e7a55246))
* minor issue with incorrect error ([65e7ea8](https://github.com/24601/halligan/commit/65e7ea8847c98dc1d7ff72c6cb4e305936941330))
* missing exported functions and variables ([e0bc6c9](https://github.com/24601/halligan/commit/e0bc6c92ec73371804b6923c3778575efff35d16))
* missing imports ([9071c9e](https://github.com/24601/halligan/commit/9071c9e109921ef20d923f51a4d42ccfbb8bb5cd))
* **mistral:** remove unsupported params and fix image compatibility ([#247](https://github.com/24601/halligan/issues/247)) ([2f3d4d6](https://github.com/24601/halligan/commit/2f3d4d6208c1067df0e26824ef5bc582ace9dde1))
* **mock:** preserve unknown structured output capability ([8836b6d](https://github.com/24601/halligan/commit/8836b6d48e335a170ea155f9426555fd99e2f8a3))
* model map issue ([ab29d6e](https://github.com/24601/halligan/commit/ab29d6e6cf39255a6b1f488043cb378387bcb5ac))
* more fixes related to model mapping ([b01fcb7](https://github.com/24601/halligan/commit/b01fcb79dc3375aabb3815fae396ec567faf7987))
* more streaming fixes ([ac3948b](https://github.com/24601/halligan/commit/ac3948bcedf4c4304ebfc1a62a1c70d8e69e1c87))
* more test coverage for function calling ([e48cf16](https://github.com/24601/halligan/commit/e48cf1667bd05e3d26b97cacdc2b914e1771b05c))
* new ai balancer to route based on token pricing in case of error ([7ea79a9](https://github.com/24601/halligan/commit/7ea79a90e0cf633d7517ce32701a9df18ba57b37))
* normalize type unions in cleanSchemaForGemini for json[] compatibility ([#488](https://github.com/24601/halligan/issues/488)) ([fdba299](https://github.com/24601/halligan/commit/fdba2995d85e715aa9b734f09ac936ee750227a2))
* old router is now simple classifier ([0c9f4f4](https://github.com/24601/halligan/commit/0c9f4f49537ec729093b8a91aa6b593ddd4f285c))
* only count last modelUsage chunk for streaming models ([#270](https://github.com/24601/halligan/issues/270)) ([e742bbd](https://github.com/24601/halligan/commit/e742bbd95014ebe3d3c2ff8c846e4a7c6eb8be61))
* openai and anthropic function calling issues ([e2fa4c0](https://github.com/24601/halligan/commit/e2fa4c09e1650f2694ba162450c53f549e62188f))
* openai function tracing fixes ([d623f03](https://github.com/24601/halligan/commit/d623f03f6e8c3ad41fe5e919ef9433135bc199d9))
* **openai:** correct stale per-model prices in OpenAI info table ([#525](https://github.com/24601/halligan/issues/525)) ([c85eceb](https://github.com/24601/halligan/commit/c85eceb058894e702d9b42ecec97cd994a60f03e))
* **openai:** keep every parallel tool call from the Responses API ([#574](https://github.com/24601/halligan/issues/574)) ([3a80c93](https://github.com/24601/halligan/commit/3a80c93e16e0a499c971bcb58f976d73e7799da3))
* **openai:** stop sending max reasoning effort on the chat path ([#569](https://github.com/24601/halligan/issues/569)) ([d749bdd](https://github.com/24601/halligan/commit/d749bdd38df2884a64e117641349c7c4536270b2))
* opentelemetry tracing added to ai and vectordb ([1918410](https://github.com/24601/halligan/commit/1918410f4d83676fbcd9720b5707e5ab664761a6))
* optimize discovery prompts for axagent ([8304a63](https://github.com/24601/halligan/commit/8304a63e74cbe17df94cc4ecbd8ad88528cf4cf9))
* **optimize:** bind receipt authority and fail closed on overflow ([72aa1de](https://github.com/24601/halligan/commit/72aa1de01717cb772a0fdb7d507b70f518af6eca))
* **optimize:** guard issued receipt fast path ([cf0bdff](https://github.com/24601/halligan/commit/cf0bdff45bb429d7546f3c0db088cfaf144b8ea4))
* **optimize:** harden causal evidence receipts ([6be9d58](https://github.com/24601/halligan/commit/6be9d58671a629fa8d2f1ba1a1d351f9584d7203))
* **optimize:** preserve causal receipt integrity ([b301d06](https://github.com/24601/halligan/commit/b301d0671a07920040b16dd7e969f9d4c0135dac))
* **optimize:** preserve typed causal evidence options ([1f35e6c](https://github.com/24601/halligan/commit/1f35e6ca50b738648ed5067479087a257b99d0eb))
* **optimize:** replay inherited causal receipts ([e693f52](https://github.com/24601/halligan/commit/e693f528e2a96eb5e5baf00c1f8da1a7dd7adf4a))
* option to disable smart routing in agents ([ce1b25f](https://github.com/24601/halligan/commit/ce1b25ff4e288647d01f032afad109a762940f4b))
* optional fields issue ([a4ecdcd](https://github.com/24601/halligan/commit/a4ecdcdbacdbfa8cd99fa1070bdd769870d53b14))
* package fixes ([e7e260b](https://github.com/24601/halligan/commit/e7e260b31716e51da04d52fc33554bd12b12cea9))
* package upgrades ([f969bd7](https://github.com/24601/halligan/commit/f969bd790d7e813ea4e450158d1f212598489039))
* package.json for publishing ([2f1b72e](https://github.com/24601/halligan/commit/2f1b72e332762ba0e9b33f8ed3db1138d9d985ea))
* parsing while end-to-end streaming ([fee7775](https://github.com/24601/halligan/commit/fee7775ae9283903aa7e8815c04a149727bcdbd1))
* passing model in forward ([a485edf](https://github.com/24601/halligan/commit/a485edfddbf2e10244c8b611bbc47097b79c8ce7))
* path fix in new apicall: ([2afc899](https://github.com/24601/halligan/commit/2afc8993f6820269d76f99c273c600de645cc864))
* **playbook:** accept structured metric scores ([be24b48](https://github.com/24601/halligan/commit/be24b48541e68180b97934bc75d06fe1be6bc133))
* polish Academy lesson states ([31f293d](https://github.com/24601/halligan/commit/31f293d0ebe925f398e3310055e4d2b6ef3b1b2e))
* port Gemini 3.7 Flash to AxIR ([8cbad4e](https://github.com/24601/halligan/commit/8cbad4e9c33543bbb441aed7628543de7bba97c8))
* preserve native images in provider router ([#580](https://github.com/24601/halligan/issues/580)) ([f78e287](https://github.com/24601/halligan/commit/f78e28737c67f67de7995c9c7aee1b739d58d5b9))
* preserve native ReAct replay IDs ([3fdbee7](https://github.com/24601/halligan/commit/3fdbee7dd2a39f870dd439d70a9c3a1d50ffc0f6))
* preserve thought_signature in Gemini 3 context cache paths ([#502](https://github.com/24601/halligan/issues/502)) ([31e2f95](https://github.com/24601/halligan/commit/31e2f95b9a4206def390937c889904aaa4c2c826))
* prettier config ([8f4ca77](https://github.com/24601/halligan/commit/8f4ca77ecfe59605295e4f3f465db420e7380b9b))
* prevent item duplication during streaming finalization [#484](https://github.com/24601/halligan/issues/484) [#484](https://github.com/24601/halligan/issues/484) ([262fd32](https://github.com/24601/halligan/commit/262fd32467685672937fd5b48ed272b1740f7b3c))
* Prevent streaming structured output duplication by refining delta calculation and resetting retry states. ([946349f](https://github.com/24601/halligan/commit/946349fe970d267ac8315cee65d2c977f478e944))
* **profiles:** declare the structured-output modes deepseek and together actually serve ([#586](https://github.com/24601/halligan/issues/586)) ([bf2460a](https://github.com/24601/halligan/commit/bf2460a5feb4347ea79a678f524695ef9ba231c4))
* **program-source:** close isolated audit findings ([329c7f7](https://github.com/24601/halligan/commit/329c7f7b0aa614904ea11fb253b4bdb4cfdeadd3))
* **program-source:** snapshot defined inputs and keep tool arity 2 ([a6f35f0](https://github.com/24601/halligan/commit/a6f35f01b10853da4f46a6a63d1932d4729140a6))
* prompt improvements ([79891d6](https://github.com/24601/halligan/commit/79891d6c756385bae19b9fa4ed674c9d597d725c))
* prompt ordering ([80dd8f2](https://github.com/24601/halligan/commit/80dd8f28c9812bbbea77754aa36c75e2967b5a7b))
* prompt updates ([6f51a92](https://github.com/24601/halligan/commit/6f51a92e26a1e543a5546321f4ab5bf9e39233b0))
* proxy command ([9eaf6e7](https://github.com/24601/halligan/commit/9eaf6e757422232135f21250300353735e4d6120))
* proxy port can be set using the env var PORT ([c08af8d](https://github.com/24601/halligan/commit/c08af8d3cac10d544794c618a8ddb6c19684ee7b))
* **rag): guard undefined retrievalResults and guarantee non-empty finalContext; fix(flow/planner:** avoid executing map transforms during analysis to prevent mock side effects; build: green across workspaces; closes [#323](https://github.com/24601/halligan/issues/323) ([d1bce5b](https://github.com/24601/halligan/commit/d1bce5b5f2bb32100a8fb2c90041ff0979d30a8b))
* **react:** close audit cancellation and replay gaps ([10b938c](https://github.com/24601/halligan/commit/10b938c43cfa958dc7b7acf183a602e91482df08))
* **react:** keep newest history group and quiesce aborted workers ([5369b16](https://github.com/24601/halligan/commit/5369b1698c023ed792a343408a7b0053999509f4))
* redesigned model map feature ([7049914](https://github.com/24601/halligan/commit/704991418fdda832ef3d6aff33496432c3b152eb))
* refactor functions ([802b288](https://github.com/24601/halligan/commit/802b288764b416a01a5266b0527d7cd1f25e2464))
* refactor MCP transport imports and update documentation ([ee4d976](https://github.com/24601/halligan/commit/ee4d976c2ac3a71f197978379e741a8fc5dae585))
* refactor to ensure config values are correctly handled ([ee5b068](https://github.com/24601/halligan/commit/ee5b06859fe60533b620b115a6b954b9b25eebe2))
* refactored request, response tracing ([1ac7023](https://github.com/24601/halligan/commit/1ac702334cd09dec9bc2f17944e67397762298ac))
* refactored usage reporting and other fixes ([84bf661](https://github.com/24601/halligan/commit/84bf661389ae806f2730bdd9d9edce2f5b932ede))
* refine field extraction logic and update test cases ([d9d9836](https://github.com/24601/halligan/commit/d9d983666a658b9d21b33757a063b5389296d512))
* relaxed model info check ([3f1fffb](https://github.com/24601/halligan/commit/3f1fffb6b28dedcdc56f8d473b9be5b7964eebb2))
* release files ([#45](https://github.com/24601/halligan/issues/45)) ([acb773a](https://github.com/24601/halligan/commit/acb773a79b73bde755fd0d0a16003e3a2c47f7dc))
* **release:** ignore unrelated local tags ([#601](https://github.com/24601/halligan/issues/601)) ([16d893e](https://github.com/24601/halligan/commit/16d893e859692ced866c158810be4b7327757075))
* Remove casting to a string value in the loader ([#37](https://github.com/24601/halligan/issues/37)) ([6b0a894](https://github.com/24601/halligan/commit/6b0a89497fa3e1217d80c6ba63a687505c0e7ff7))
* remove comments ([73e3a30](https://github.com/24601/halligan/commit/73e3a3021d63e0b1fb2dcd6fc4b3e7a8267de4b1))
* remove index folder committed by mistake ([4d327ab](https://github.com/24601/halligan/commit/4d327abbbc7fb30041266f8cfdc426c7435c0a5f))
* remove unused @types/uuid dev dependency breaking type-checks ([876e45c](https://github.com/24601/halligan/commit/876e45c04c207255fd9bc0b299e81e1cbd29acc5))
* removed crawler ([ab4ac6e](https://github.com/24601/halligan/commit/ab4ac6e10742611516067d937ab0350338973a3e))
* removed extra packages ([faae6d2](https://github.com/24601/halligan/commit/faae6d2512415cd8419105129a2a63527ec05371))
* removed publish from exmples ([d167f64](https://github.com/24601/halligan/commit/d167f646e36a9d59668fadc6131bb403e49ad5c1))
* renamed emailprompt to messageprompt ([3063a90](https://github.com/24601/halligan/commit/3063a907ed5383c63ed6f79cf1bcc27bf1fd04ac))
* renamed responseSchema to resultSchema for clarity ([b238b88](https://github.com/24601/halligan/commit/b238b88561cea813f3183d419b09b7f3386d16aa))
* repair event runtime CI build ([8ef7d05](https://github.com/24601/halligan/commit/8ef7d055642b98356f2ad7afd41446c9433e3bf4))
* required values validation ([f997236](https://github.com/24601/halligan/commit/f997236f698fe1745fb3db49afda0af772f82d58))
* resolved all typescript strict mode errors and warnings ([4f08fac](https://github.com/24601/halligan/commit/4f08face90d761faf97609213f88bbc84922d57c))
* result error-correction fixes ([eeaa12e](https://github.com/24601/halligan/commit/eeaa12e605f210df66c82a6f40e368d0ac6f0289))
* retry logic in apicall ([db83ba4](https://github.com/24601/halligan/commit/db83ba4b6a36286ca56ab99f6d6ace5fb7871f34))
* reword comment for spelling gate ([27e2273](https://github.com/24601/halligan/commit/27e2273992c4379b317ab9e575a8ca6f859b7094))
* rewrite or error-correction code and other fixes ([37b620e](https://github.com/24601/halligan/commit/37b620e576982660d1013547043b07a1642b9892))
* **runtime:** bind admissions to exact implementations ([7fea9a3](https://github.com/24601/halligan/commit/7fea9a3f8b10fd10445c20889e8b1e0dc4eaea92))
* **runtime:** block indirect tagged host calls ([75964a3](https://github.com/24601/halligan/commit/75964a35a5e1ecdf77e7d4c1b0713bca1fcf7adb))
* **runtime:** capture admitted executable metadata ([6684e3a](https://github.com/24601/halligan/commit/6684e3ae1b9427d1f383510f8a60a1c580e6c7f3))
* **runtime:** capture canonical metadata once ([b65ce71](https://github.com/24601/halligan/commit/b65ce71d4ef29791cd4b255733f3ce7acdeee591))
* **runtime:** close speculative claim races and protocol gaps ([6b9d20e](https://github.com/24601/halligan/commit/6b9d20eb548050b76bec413ec50c611d72c6035e))
* **runtime:** fail closed on unsafe speculative mutations ([4a2a55b](https://github.com/24601/halligan/commit/4a2a55bc71977fe8fe84149bd6f408a060468959))
* **runtime:** harden capability conformance boundaries ([71548d4](https://github.com/24601/halligan/commit/71548d4e12a5acdd2d57377145ba3e48b9857f3d))
* **runtime:** isolate canonical requirement records ([35362bd](https://github.com/24601/halligan/commit/35362bd7dd40e12d055edd7a8ed87c0107382ccc))
* **runtime:** isolate speculative call arguments ([7eac98f](https://github.com/24601/halligan/commit/7eac98f0d58a0bb3acf052b1ed4a8cc9acb56ed0))
* **runtime:** lock admitted security state ([e1ad3ff](https://github.com/24601/halligan/commit/e1ad3ff094463707396542666e77f76f76bcde21))
* **runtime:** preserve denied speculation semantics ([6464131](https://github.com/24601/halligan/commit/64641316b0370e39483cd0b22b57c2f8b2e51708))
* **runtime:** preserve recorder serialization failures ([9d4fd8c](https://github.com/24601/halligan/commit/9d4fd8c393d8d1f573925ef3cd525d16282d8a7a))
* **runtime:** preserve speculative execution ordering ([8716331](https://github.com/24601/halligan/commit/871633101bfba9c8c4a9b9ed026bd979d5690d6e))
* **runtime:** prevent subclass admission bypass ([1f96e38](https://github.com/24601/halligan/commit/1f96e3811ba9a5c23f7ebd829f10a7b75b720fc4))
* **runtime:** require host admission for security selection ([9b91b66](https://github.com/24601/halligan/commit/9b91b6628ab65820c22079e289c974b90bfd8dee))
* **runtime:** snapshot selection requirements ([ada23b6](https://github.com/24601/halligan/commit/ada23b66a208a6d5e2fa0aff6c733d2025e9f3fa))
* **runtime:** throw host callable errors into actor code ([#599](https://github.com/24601/halligan/issues/599)) ([b846449](https://github.com/24601/halligan/commit/b846449d5d3ef19e05d8623bb42bf43006d433fd))
* **runtime:** typecheck isolated protocol replay and cover llmQuery debit tests ([02142b0](https://github.com/24601/halligan/commit/02142b028fa7aeaf52ccf0430c41e5ee022e9e11))
* **rust:** update tungstenite within MSRV ([3ba539b](https://github.com/24601/halligan/commit/3ba539b9a281c5ff8577907566577bffd9040c45))
* seperated embed usage data from completion usage ([feb5619](https://github.com/24601/halligan/commit/feb5619f4df104e31edfbdd24f909a6c1b255a7f))
* set default model for openai to gpt3-turbo ([14ba73c](https://github.com/24601/halligan/commit/14ba73cc1fc80436c2073c85f5717215d03655a5))
* several issues with agents ([5800ff0](https://github.com/24601/halligan/commit/5800ff0f4cc6e0b7f5931e211dc679e0088d0879))
* **sig:** avoid structuredClone on Zod-backed fields, expose AxSignatureConfig overloads ([#512](https://github.com/24601/halligan/issues/512)) ([0222938](https://github.com/24601/halligan/commit/0222938150107f4b2b0bc3447e5bdd6746577472))
* signature parser ([a149361](https://github.com/24601/halligan/commit/a149361263cae6e4bdc8a425f1abadd38ef9da56))
* silence unused-variable lint warning in mermaid node resolution ([471f129](https://github.com/24601/halligan/commit/471f129ce1daf383f66fba2be2bd9f043eb5add2))
* simplify Ax Academy hero layout ([478c21d](https://github.com/24601/halligan/commit/478c21da2040be7c3d50540bb84f28f608cfa7eb))
* **skill:** drop false claim that forward() exposes memory results ([e8f5686](https://github.com/24601/halligan/commit/e8f5686ed9550d982bdb61573499adac4f740b8a))
* snapshot predictor bridge authority ([05d9979](https://github.com/24601/halligan/commit/05d9979859ab64eb62d185eac893362c1d428ed5))
* spelling ([cbe25eb](https://github.com/24601/halligan/commit/cbe25eb09b0ab1c77336bfd8965c489403be26d0))
* standardize global variable naming and enhance API configuration ([7cc2f76](https://github.com/24601/halligan/commit/7cc2f76b61aa6b6f8911e67e4d889bc72f3c477c))
* stop duplicating object array items when streaming structured output ([#565](https://github.com/24601/halligan/issues/565)) ([f414c6d](https://github.com/24601/halligan/commit/f414c6d7b7038e611bc0d3f66b633a14d65aadd3)), closes [#564](https://github.com/24601/halligan/issues/564) [#568](https://github.com/24601/halligan/issues/568)
* streaming fix in ai sdk provider ([192adac](https://github.com/24601/halligan/commit/192adacba1aafd0fea8703904c2e5d6177159c23))
* streaming parser overflow ([9bad370](https://github.com/24601/halligan/commit/9bad370ee3938007164014018986eacb7e01452d))
* streaming parser overrun ([b7a6a15](https://github.com/24601/halligan/commit/b7a6a1536950b856fc3d5955f11a265fb8990cea))
* streamline memory tag management and improve test coverage ([870ebe2](https://github.com/24601/halligan/commit/870ebe2b4e7ef604fb8976acfe9d5cd41ac6ec62))
* streamlined the llm apis ([0bbc8b0](https://github.com/24601/halligan/commit/0bbc8b0729ef95657642ae3459fb43f5bbc666ff))
* support DeepSeek reasoning tool loops ([431a56a](https://github.com/24601/halligan/commit/431a56a78d9a49e9a3ff77100a0d63f93ec835b5))
* support for Gemini Flash <= 2.0 ([#233](https://github.com/24601/halligan/issues/233)) ([6424329](https://github.com/24601/halligan/commit/64243297a3bbc24aee512a1e1445a8f28fec7b58))
* system prompt fixes ([b56201c](https://github.com/24601/halligan/commit/b56201caf00df323925d2864f5c70f9ff70ee234))
* system role bug in anthropic ([e566eb2](https://github.com/24601/halligan/commit/e566eb270115b87f288bcdd9c297a084a51a81a0))
* test failures ([c8e5cae](https://github.com/24601/halligan/commit/c8e5cae62415d3824bff148550f733f4815e4f1d))
* test issue ([91b15c1](https://github.com/24601/halligan/commit/91b15c1cfd808b3d071db960dd58b8014fe09260))
* **test:** migrate concurrent inference-fix regression tests off removed fromMermaid ([be74a16](https://github.com/24601/halligan/commit/be74a16dd6f194390a6b44d421865786a6008db4))
* tests breaking ([4c047ce](https://github.com/24601/halligan/commit/4c047ce964d626129e0219e2dfef6ce7344f3747))
* tracing fixes ([2aa7f04](https://github.com/24601/halligan/commit/2aa7f0410ea9120aaf3b772704302269e05d4ebd))
* ts cleanup ([be645d9](https://github.com/24601/halligan/commit/be645d952bec4d1b5022732a58a8705479147fbd))
* tsup config bug ([#276](https://github.com/24601/halligan/issues/276)) ([a6af394](https://github.com/24601/halligan/commit/a6af394e52f3be9be4b3eefd763df31f4156b394))
* tuning and optimization fixes ([d0b892c](https://github.com/24601/halligan/commit/d0b892c7dd56f5720b75f8fe438cff8a5a29e535))
* type fix ([a5a0cc6](https://github.com/24601/halligan/commit/a5a0cc65dfe36ee385bc08b658d796846cd496c4))
* type issue ([9b16404](https://github.com/24601/halligan/commit/9b1640457be7092d0abf8a7f492a5d2a987549dc))
* type validation logic ([88eec1e](https://github.com/24601/halligan/commit/88eec1ebb4faa126ec491785c552a4958369f030))
* TypeError: Cannot read properties of undefined (reading 'length') ([#131](https://github.com/24601/halligan/issues/131)) ([a997f5b](https://github.com/24601/halligan/commit/a997f5be14be512fd3457c67f9aa2948f01c0d4a))
* types cleanup, all model inputs are clearly typed ([192d9d4](https://github.com/24601/halligan/commit/192d9d43d0524ced16bf9257b20610b9a3040112))
* unify llmQuery functionality and update documentation ([af64cf9](https://github.com/24601/halligan/commit/af64cf9fdf602e46149b5cdd2fe155176383eb62))
* update AxJSRuntime usage instructions and enhance llmQuery handling in AxAgent ([c424489](https://github.com/24601/halligan/commit/c424489ae1bd75cca5723cec29837a1e94bc5d3b))
* update AxMultiMetricFn type definition and clean up imports ([06c3960](https://github.com/24601/halligan/commit/06c3960fc86a3f27d92e65e6ff4bba21242a7102))
* update dependencies and enhance Gemini model handling ([1b03d62](https://github.com/24601/halligan/commit/1b03d62b5eed002035be1ba2a45e02733ac34f4e))
* update import paths for model information in AI modules ([3f4ca8d](https://github.com/24601/halligan/commit/3f4ca8dc19ff99202dd9454ee9f4d161f4ff4e47))
* update model defaults ([1c70dd7](https://github.com/24601/halligan/commit/1c70dd7b2631f865216ae4d90c304db56880a806))
* update model defaults ([cc7e82f](https://github.com/24601/halligan/commit/cc7e82f0033f4881bc473dec53dc770023c32eab))
* update model defaults ([1251372](https://github.com/24601/halligan/commit/12513727f3b7f683858eed549f4ecea87883f91e))
* update model names and costs for Google Gemini configurations ([48b3235](https://github.com/24601/halligan/commit/48b3235645820064a3b9057fc073c96faed4185b))
* update package exports for browser compatibility ([191d4a3](https://github.com/24601/halligan/commit/191d4a3f61d494a9cea6482b81dadf240210e73e))
* update package name ([ed5346c](https://github.com/24601/halligan/commit/ed5346c029e8228e37bae6494337496db5a4d774))
* update project words list to include 'openrouter' ([f8c2f58](https://github.com/24601/halligan/commit/f8c2f589f15d2aec562711bcf9379710a41dadb5))
* update readme ([5b73fd1](https://github.com/24601/halligan/commit/5b73fd1caa8b0b0e703b3a1ae72ef2803c211a09))
* update README and enhance AxBaseAI tests for model configuration merging ([40690b3](https://github.com/24601/halligan/commit/40690b3c60795c4cfd3fc5f3f3e71e8656622ff5))
* update README and examples for improved CDN usage and module imports ([33f734c](https://github.com/24601/halligan/commit/33f734ce8a3969d30518b5e8a01185489c6c67b1))
* update redirection logic for documentation paths ([159c6c4](https://github.com/24601/halligan/commit/159c6c4812b874f942ef31b3de43fcf214eebc77))
* update schema validation to allow arbitrary JSON objects in structured outputs ([77c4583](https://github.com/24601/halligan/commit/77c458320f12c78ee004b1cb13ddd73d5ef4b686))
* update typedef to support async version ([#294](https://github.com/24601/halligan/issues/294)) ([45f07a2](https://github.com/24601/halligan/commit/45f07a2ec32255fe1f9adb888358aa11ffad354a))
* Updated Cohere reqValue to include input_type (required since v3), Groq model to llama3-70b-8192 (llama2-70b-4096 was depreciated), and added a temporary fix to the marketing.py example (messageGuidelines expects a string, not a string array). ([#22](https://github.com/24601/halligan/issues/22)) ([5885877](https://github.com/24601/halligan/commit/5885877ecb2294566713abe323344c1b67eae9ba))
* updates to ai sdk provider ([ca62b91](https://github.com/24601/halligan/commit/ca62b91d4eb117cda29695c0b4842a21e95caba3))
* updates to debugging proxy ([6476a23](https://github.com/24601/halligan/commit/6476a23a6b297f216b45afff12d1f37883714a92))
* updates to the ai sdk provider ([01fca9a](https://github.com/24601/halligan/commit/01fca9abf00cc8a24e649575a7c0f5558fe21d66))
* updates to the ai sdk provider ([ff77e1f](https://github.com/24601/halligan/commit/ff77e1f4959e8aad71b8b87e4b084cf992972522))
* updates to the ai sdk provider ([148e692](https://github.com/24601/halligan/commit/148e692d4d2aadf0c04260ec6030cb2c7aa6141f))
* use cache_control on a content block, not the content itself ([#479](https://github.com/24601/halligan/issues/479)) ([1542957](https://github.com/24601/halligan/commit/15429572a7f933c84425d4ecaaef056dd74e4fd2))
* **util:** browser SSE streams end with a spurious network error ([#571](https://github.com/24601/halligan/issues/571)) ([ae0dcee](https://github.com/24601/halligan/commit/ae0dceed41fdcd20958942b0a090c22580333712))
* **util:** classify mid-stream caller aborts ([#577](https://github.com/24601/halligan/issues/577)) ([91d68cd](https://github.com/24601/halligan/commit/91d68cdc75c5a303fbe6f76f5821ff0c7443d6ce))
* valid healthcheck path for proxy ([3adea76](https://github.com/24601/halligan/commit/3adea76b081cc433450229c449f0c65bcb2a8cf7))
* validate url arrays per-item instead of on the whole array ([#567](https://github.com/24601/halligan/issues/567)) ([87a6720](https://github.com/24601/halligan/commit/87a6720829b6937909ecc6da6cae993de4c5a73c))
* value parseing ([5a6c0e3](https://github.com/24601/halligan/commit/5a6c0e349e4868f68f2f3b7fe63dfeb14d5f9a13))
* various fixes ([d12a683](https://github.com/24601/halligan/commit/d12a683e54e55463169fb0d13ca59e84eeb23e25))
* various fixes ([5d257d5](https://github.com/24601/halligan/commit/5d257d5e8e7f3f9ff474b072a35a52a1f6768eb5))
* various fixes ([f50828c](https://github.com/24601/halligan/commit/f50828cd158e92300430203b8a9eb54c0d5d7280))
* various fixes ([05cbc64](https://github.com/24601/halligan/commit/05cbc64ba6ec7b00cd2417be154e17fd95df7578))
* various fixes ([a0099a8](https://github.com/24601/halligan/commit/a0099a8958fae739d431a82a8715cf86bc2e74b5))
* various fixes ([7b75342](https://github.com/24601/halligan/commit/7b753421b438d2f01ae20b0a25549c994bdd07b3))
* various fixes ([440cb84](https://github.com/24601/halligan/commit/440cb842a8c39f00b1ba7fbb6c4523a1d1275387))
* various fixes ([516fbcb](https://github.com/24601/halligan/commit/516fbcbf69f42d4a3d0a9169098087a0d603e945))
* various fixes ([0978b29](https://github.com/24601/halligan/commit/0978b2904454b1928f5254f1f241797f77a64ac2))
* various fixes to multiservice router ([16bcd22](https://github.com/24601/halligan/commit/16bcd22d2d9a85c77df67d1f462d3382f8a45a6c))
* various issues including [#80](https://github.com/24601/halligan/issues/80) ([9a3d5d4](https://github.com/24601/halligan/commit/9a3d5d4bec68ce2a221a5133eaaa31dd3382b4b7))
* various proxy fixes ([61b693a](https://github.com/24601/halligan/commit/61b693a9c95b4f173ca48bcc91b9154cfabc2963))
* various rlm runtime fixes ([929939e](https://github.com/24601/halligan/commit/929939e5aacbe3cf74dae30025d18415b4e43389))
* various test fixes ([1d6f4e7](https://github.com/24601/halligan/commit/1d6f4e71cbb0f3172edff38d65cea5968046923d))
* version update ([c4794a3](https://github.com/24601/halligan/commit/c4794a3e1853c58b60f7e9357d755dab4bca6e4e))
* vertex ai and streaming fixes ([8c0ade9](https://github.com/24601/halligan/commit/8c0ade90bd39134882563c717a2205adf30a7d61))
* vertex embeddings api changes ([5e5fdaf](https://github.com/24601/halligan/commit/5e5fdaf6e6818df5659c7156194bb4fcb94508a3))
* **vertex:** use correct Vertex AI endpoint for global region ([#428](https://github.com/24601/halligan/issues/428)) ([1466bc7](https://github.com/24601/halligan/commit/1466bc75d1d8b249a66a94111d5371f66a4c23d8))
* **webllm:** preserve typed function-result parts on the wire ([#591](https://github.com/24601/halligan/issues/591)) ([72f9f73](https://github.com/24601/halligan/commit/72f9f732c54d5b1015ba0990e74aa1a755971a0b))
* **website:** stop hero example swaps from reflowing the page; calmer two-line h1 ([1758469](https://github.com/24601/halligan/commit/17584697655efa1b38748a89cf6651255a48d038))
* whitespace streaming extract issue ([9706b4f](https://github.com/24601/halligan/commit/9706b4f1fecb6db3d74cde2271e8627208204c45))
* with and without signature base program classes ([a3f27a6](https://github.com/24601/halligan/commit/a3f27a61a92d48f2ffe7a4d6f5d4739ac0bf224f))
* **worker:** use bundler-safe require access in serialized runtime ([4c0e127](https://github.com/24601/halligan/commit/4c0e127b67d325ee269a6eb29ba16e8b7c72f0a7))
* zprompt type spec ([db1f7e7](https://github.com/24601/halligan/commit/db1f7e75c4ac176ea3ca424e5fc276d5e43081be))

### Performance Improvements

* **agent:** shrink RLM actor system prompt by ~480 chars ([ce46475](https://github.com/24601/halligan/commit/ce4647514585277eb0fa3815a467f22991387925))

### Reverts

* Revert "chore(axir): drop mermaid + extended-grammar ports-parity entries" ([9e73091](https://github.com/24601/halligan/commit/9e73091398c1ffb5b4f4acaf13eccb947211ecbe))
* Revert "Docs ax functions (#291)" ([de65289](https://github.com/24601/halligan/commit/de6528914eee7b7d1490e1a8ccae939d86364574)), closes [#291](https://github.com/24601/halligan/issues/291)

## [24.0.8](https://github.com/ax-llm/ax/compare/24.0.6...24.0.7) (2026-08-25)

### Bug Fixes

* **go/goja:** truncate an oversized log line instead of deleting it ([#604](https://github.com/ax-llm/ax/issues/604)) ([736ae2b](https://github.com/ax-llm/ax/commit/736ae2b9f1a3d14572a357133294b046635aff72)), closes [#602](https://github.com/ax-llm/ax/issues/602) [#602](https://github.com/ax-llm/ax/issues/602)

## [24.0.7](https://github.com/ax-llm/ax/compare/24.0.6...24.0.7) (2026-08-25)

### Bug Fixes

* **go/goja:** surface console output to the actor as per-turn logs ([#602](https://github.com/ax-llm/ax/issues/602)) ([e8b2618](https://github.com/ax-llm/ax/commit/e8b261853617a203a540c595e2408105785614ad))
* **release:** ignore unrelated local tags ([#601](https://github.com/ax-llm/ax/issues/601)) ([16d893e](https://github.com/ax-llm/ax/commit/16d893e859692ced866c158810be4b7327757075))

## [24.0.7](https://github.com/ax-llm/ax/compare/24.0.5...24.0.6) (2026-08-25)

### Bug Fixes

* **go/goja:** surface console output to the actor as per-turn logs ([#602](https://github.com/ax-llm/ax/issues/602)) ([e8b2618](https://github.com/ax-llm/ax/commit/e8b261853617a203a540c595e2408105785614ad))
* **release:** ignore unrelated local tags ([#601](https://github.com/ax-llm/ax/issues/601)) ([16d893e](https://github.com/ax-llm/ax/commit/16d893e859692ced866c158810be4b7327757075))

## [24.0.6](https://github.com/ax-llm/ax/compare/24.0.5...24.0.6) (2026-08-23)

### Bug Fixes

* **runtime:** throw host callable errors into actor code ([#599](https://github.com/ax-llm/ax/issues/599)) ([b846449](https://github.com/ax-llm/ax/commit/b846449d5d3ef19e05d8623bb42bf43006d433fd))

## [24.0.6](https://github.com/ax-llm/ax/compare/24.0.1...24.0.5) (2026-08-23)

### Bug Fixes

* **runtime:** throw host callable errors into actor code ([#599](https://github.com/ax-llm/ax/issues/599)) ([b846449](https://github.com/ax-llm/ax/commit/b846449d5d3ef19e05d8623bb42bf43006d433fd))

## [24.0.5](https://github.com/ax-llm/ax/compare/24.0.1...24.0.5) (2026-08-23)

### Bug Fixes

* **axir:** preserve native images in provider routing ([#597](https://github.com/ax-llm/ax/issues/597)) ([3751f79](https://github.com/ax-llm/ax/commit/3751f79eda7aa4c3c50bcf2c9a0a458661c36eed))
* **ci:** honor AxIR non-portable exemptions ([#596](https://github.com/ax-llm/ax/issues/596)) ([f0f155c](https://github.com/ax-llm/ax/commit/f0f155c0b14d4340770d26ec6a51c6e6f8321298))
* preserve native images in provider router ([#580](https://github.com/ax-llm/ax/issues/580)) ([f78e287](https://github.com/ax-llm/ax/commit/f78e28737c67f67de7995c9c7aee1b739d58d5b9))
* **webllm:** preserve typed function-result parts on the wire ([#591](https://github.com/ax-llm/ax/issues/591)) ([72f9f73](https://github.com/ax-llm/ax/commit/72f9f732c54d5b1015ba0990e74aa1a755971a0b))

## [24.0.5](https://github.com/ax-llm/ax/compare/24.0.3...24.0.1) (2026-08-23)

### Bug Fixes

* **axir:** preserve native images in provider routing ([#597](https://github.com/ax-llm/ax/issues/597)) ([3751f79](https://github.com/ax-llm/ax/commit/3751f79eda7aa4c3c50bcf2c9a0a458661c36eed))
* **ci:** honor AxIR non-portable exemptions ([#596](https://github.com/ax-llm/ax/issues/596)) ([f0f155c](https://github.com/ax-llm/ax/commit/f0f155c0b14d4340770d26ec6a51c6e6f8321298))
* preserve native images in provider router ([#580](https://github.com/ax-llm/ax/issues/580)) ([f78e287](https://github.com/ax-llm/ax/commit/f78e28737c67f67de7995c9c7aee1b739d58d5b9))
* **webllm:** preserve typed function-result parts on the wire ([#591](https://github.com/ax-llm/ax/issues/591)) ([72f9f73](https://github.com/ax-llm/ax/commit/72f9f732c54d5b1015ba0990e74aa1a755971a0b))

## [24.0.4](https://github.com/ax-llm/ax/compare/24.0.3...24.0.1) (2026-08-22)

### Bug Fixes

* **axir:** preserve native images in provider routing ([#597](https://github.com/ax-llm/ax/issues/597)) ([3751f79](https://github.com/ax-llm/ax/commit/3751f79eda7aa4c3c50bcf2c9a0a458661c36eed))
* **ci:** honor AxIR non-portable exemptions ([#596](https://github.com/ax-llm/ax/issues/596)) ([f0f155c](https://github.com/ax-llm/ax/commit/f0f155c0b14d4340770d26ec6a51c6e6f8321298))
* preserve native images in provider router ([#580](https://github.com/ax-llm/ax/issues/580)) ([f78e287](https://github.com/ax-llm/ax/commit/f78e28737c67f67de7995c9c7aee1b739d58d5b9))
* **webllm:** preserve typed function-result parts on the wire ([#591](https://github.com/ax-llm/ax/issues/591)) ([72f9f73](https://github.com/ax-llm/ax/commit/72f9f732c54d5b1015ba0990e74aa1a755971a0b))

## [24.0.3](https://github.com/ax-llm/ax/compare/24.0.1...24.0.1) (2026-08-21)

## [24.0.2](https://github.com/ax-llm/ax/compare/24.0.0...24.0.1) (2026-08-21)

## [24.0.1](https://github.com/ax-llm/ax/compare/24.0.0...24.0.1) (2026-08-20)

### Features

* add OrcaRouter named deployment profile ([#584](https://github.com/ax-llm/ax/issues/584)) ([95e4fab](https://github.com/ax-llm/ax/commit/95e4fab0c00e62805322989d0993bb9e2269882b))

### Bug Fixes

* **axir:** wrap forced structured-output tool_choice in a function envelope ([#585](https://github.com/ax-llm/ax/issues/585)) ([a7e05ed](https://github.com/ax-llm/ax/commit/a7e05ed2daeba734dc198b5bf5641b63425c9645)), closes [#518](https://github.com/ax-llm/ax/issues/518)
* **profiles:** declare the structured-output modes deepseek and together actually serve ([#586](https://github.com/ax-llm/ax/issues/586)) ([bf2460a](https://github.com/ax-llm/ax/commit/bf2460a5feb4347ea79a678f524695ef9ba231c4))

## [24.0.1](https://github.com/ax-llm/ax/compare/23.0.16...24.0.0) (2026-08-20)

### Features

* add OrcaRouter named deployment profile ([#584](https://github.com/ax-llm/ax/issues/584)) ([95e4fab](https://github.com/ax-llm/ax/commit/95e4fab0c00e62805322989d0993bb9e2269882b))

### Bug Fixes

* **axir:** wrap forced structured-output tool_choice in a function envelope ([#585](https://github.com/ax-llm/ax/issues/585)) ([a7e05ed](https://github.com/ax-llm/ax/commit/a7e05ed2daeba734dc198b5bf5641b63425c9645)), closes [#518](https://github.com/ax-llm/ax/issues/518)
* **profiles:** declare the structured-output modes deepseek and together actually serve ([#586](https://github.com/ax-llm/ax/issues/586)) ([bf2460a](https://github.com/ax-llm/ax/commit/bf2460a5feb4347ea79a678f524695ef9ba231c4))

## [24.0.0](https://github.com/ax-llm/ax/compare/23.0.16...24.0.0) (2026-08-19)

### Features

* add AxGen multi-sampling parity ([#582](https://github.com/ax-llm/ax/issues/582)) ([4483dd8](https://github.com/ax-llm/ax/commit/4483dd85ca2eff4f6f3c34f423c2b0ef3500e752))
* add named AI deployment profiles ([dec44b8](https://github.com/ax-llm/ax/commit/dec44b8fdd4a8e8deb776de0d441385d974e1f27))
* add portable structured output and renewable credentials ([1b3b597](https://github.com/ax-llm/ax/commit/1b3b5979e2a39c391c06f7018dcaef467d58cac8))

### Bug Fixes

* **ci:** recognize provider kwargs term ([97c1032](https://github.com/ax-llm/ax/commit/97c10320462a77f5e4b6b7b7b73b448f361078b1))

## [24.0.0](https://github.com/ax-llm/ax/compare/23.0.15...23.0.16) (2026-08-19)

### Features

* add AxGen multi-sampling parity ([#582](https://github.com/ax-llm/ax/issues/582)) ([4483dd8](https://github.com/ax-llm/ax/commit/4483dd85ca2eff4f6f3c34f423c2b0ef3500e752))
* add named AI deployment profiles ([dec44b8](https://github.com/ax-llm/ax/commit/dec44b8fdd4a8e8deb776de0d441385d974e1f27))
* add portable structured output and renewable credentials ([1b3b597](https://github.com/ax-llm/ax/commit/1b3b5979e2a39c391c06f7018dcaef467d58cac8))

### Bug Fixes

* **ci:** recognize provider kwargs term ([97c1032](https://github.com/ax-llm/ax/commit/97c10320462a77f5e4b6b7b7b73b448f361078b1))

## [23.0.16](https://github.com/ax-llm/ax/compare/23.0.15...23.0.16) (2026-08-17)

### Bug Fixes

* **agent:** document native MCP tools to the RLM actor as mcp.<ns>.tools.<name> ([#575](https://github.com/ax-llm/ax/issues/575)) ([#578](https://github.com/ax-llm/ax/issues/578)) ([d1174c1](https://github.com/ax-llm/ax/commit/d1174c10bbb3944020a423267e560cb6b9f739db))

## Next major

- Added named deployment profiles, `AxAIProfileId`, `AxAIProfileSummary`,
  `axAIProfiles()`, and `axGetAIProfile()`. The deployment name now owns endpoint,
  authentication, capabilities, and model rules; model IDs never select another
  provider's behavior.
- Split official `openai` behavior from conservative `openai-compatible`
  custom endpoints and made unknown profile names an error.
- Removed the profile-only `AxAIAzureOpenAI`, `AxAICohere`, `AxAIDeepSeek`,
  `AxAIDeepSeekResponses`, `AxAIMistral`, `AxAIReka`, and `AxAIGrok` classes.
  Use `ai({ name: '…' })`; existing model enum/catalog exports remain.
- Generated Go, Python, Rust, Java, and C++ factories now resolve the canonical
  AxIR profile manifest and expose only genuine transport clients.
- Verified DeepSeek V4 deployment rules now default an omitted thinking level
  to logical `max`; an explicit `none` still disables thinking where supported.
- Added verified maximum-reasoning defaults for current Grok, Groq GPT-OSS and
  Qwen, Cerebras GPT-OSS and Gemma, and DeepInfra DeepSeek R1 rules. Explicit
  `none` now fails before network I/O for models whose deployment cannot disable
  reasoning; dynamic Hugging Face Router routes remain conservative.
- Added ordered `native`, `function`, and `json_object` structured-output modes
  to profile/model capability resolution and direct AxGen/Agent forward options.
  Explicit unsupported modes now fail before transport.
- Added the exact Vertex Gemma MaaS rule for
  `google/gemma-4-26b-a4b-it-maas`: JSON-object output without native schema,
  maximum thinking by default, nested `enable_thinking`, and
  `reasoning_content` extraction/replay. Unknown Vertex models stay
  conservative.
- Added per-request renewable credential providers across TypeScript and all
  five generated runtimes. Fresh headers override static authentication for
  chat, stream, embeddings, Responses, audio, and retries; completed 401/403
  responses are not replayed automatically.

## [23.0.16](https://github.com/ax-llm/ax/compare/23.0.14...23.0.15) (2026-08-17)

### Bug Fixes

* **agent:** document native MCP tools to the RLM actor as mcp.<ns>.tools.<name> ([#575](https://github.com/ax-llm/ax/issues/575)) ([#578](https://github.com/ax-llm/ax/issues/578)) ([d1174c1](https://github.com/ax-llm/ax/commit/d1174c10bbb3944020a423267e560cb6b9f739db))

## [23.0.15](https://github.com/ax-llm/ax/compare/23.0.14...23.0.15) (2026-08-15)

### Bug Fixes

* **axir:** preserve structured output contracts ([73f1160](https://github.com/ax-llm/ax/commit/73f1160dfe467c3feda0feb1d15f3f411197a70e))
* **mock:** preserve unknown structured output capability ([8836b6d](https://github.com/ax-llm/ax/commit/8836b6d48e335a170ea155f9426555fd99e2f8a3))

## [23.0.15](https://github.com/ax-llm/ax/compare/23.0.13...23.0.14) (2026-08-15)

### Bug Fixes

* **axir:** preserve structured output contracts ([73f1160](https://github.com/ax-llm/ax/commit/73f1160dfe467c3feda0feb1d15f3f411197a70e))
* **mock:** preserve unknown structured output capability ([8836b6d](https://github.com/ax-llm/ax/commit/8836b6d48e335a170ea155f9426555fd99e2f8a3))

## [23.0.14](https://github.com/ax-llm/ax/compare/23.0.13...23.0.14) (2026-08-15)

### Bug Fixes

* **axir:** mark DeepSeek structured outputs unsupported ([bdb08b7](https://github.com/ax-llm/ax/commit/bdb08b788f7b452f54681040e44652fdbc24e0b4))
* **deepseek:** advertise unsupported structured outputs ([36dc421](https://github.com/ax-llm/ax/commit/36dc4218053864e0cfe2e9050860719b352c9c50))
* **openai:** keep every parallel tool call from the Responses API ([#574](https://github.com/ax-llm/ax/issues/574)) ([3a80c93](https://github.com/ax-llm/ax/commit/3a80c93e16e0a499c971bcb58f976d73e7799da3))

## [23.0.14](https://github.com/ax-llm/ax/compare/23.0.12...23.0.13) (2026-08-15)

### Bug Fixes

* **axir:** mark DeepSeek structured outputs unsupported ([bdb08b7](https://github.com/ax-llm/ax/commit/bdb08b788f7b452f54681040e44652fdbc24e0b4))
* **deepseek:** advertise unsupported structured outputs ([36dc421](https://github.com/ax-llm/ax/commit/36dc4218053864e0cfe2e9050860719b352c9c50))
* **openai:** keep every parallel tool call from the Responses API ([#574](https://github.com/ax-llm/ax/issues/574)) ([3a80c93](https://github.com/ax-llm/ax/commit/3a80c93e16e0a499c971bcb58f976d73e7799da3))

## [23.0.13](https://github.com/ax-llm/ax/compare/23.0.12...23.0.13) (2026-08-14)

### Bug Fixes

* port Gemini 3.7 Flash to AxIR ([8cbad4e](https://github.com/ax-llm/ax/commit/8cbad4e9c33543bbb441aed7628543de7bba97c8))
* support DeepSeek reasoning tool loops ([431a56a](https://github.com/ax-llm/ax/commit/431a56a78d9a49e9a3ff77100a0d63f93ec835b5))

## [23.0.13](https://github.com/ax-llm/ax/compare/23.0.11...23.0.12) (2026-08-14)

### Bug Fixes

* port Gemini 3.7 Flash to AxIR ([8cbad4e](https://github.com/ax-llm/ax/commit/8cbad4e9c33543bbb441aed7628543de7bba97c8))
* support DeepSeek reasoning tool loops ([431a56a](https://github.com/ax-llm/ax/commit/431a56a78d9a49e9a3ff77100a0d63f93ec835b5))

## [23.0.12](https://github.com/ax-llm/ax/compare/23.0.11...23.0.12) (2026-08-12)

### Bug Fixes

* **anthropic:** correct Claude Sonnet 5 to its permanent token pricing ([#576](https://github.com/ax-llm/ax/issues/576)) ([526b8fc](https://github.com/ax-llm/ax/commit/526b8fc460125568ada54dbf02f29bba147ab2b4))
* **util:** classify mid-stream caller aborts ([#577](https://github.com/ax-llm/ax/issues/577)) ([91d68cd](https://github.com/ax-llm/ax/commit/91d68cdc75c5a303fbe6f76f5821ff0c7443d6ce))

## [23.0.12](https://github.com/ax-llm/ax/compare/23.0.10...23.0.11) (2026-08-12)

### Bug Fixes

* **anthropic:** correct Claude Sonnet 5 to its permanent token pricing ([#576](https://github.com/ax-llm/ax/issues/576)) ([526b8fc](https://github.com/ax-llm/ax/commit/526b8fc460125568ada54dbf02f29bba147ab2b4))
* **util:** classify mid-stream caller aborts ([#577](https://github.com/ax-llm/ax/issues/577)) ([91d68cd](https://github.com/ax-llm/ax/commit/91d68cdc75c5a303fbe6f76f5821ff0c7443d6ce))

## [23.0.11](https://github.com/ax-llm/ax/compare/23.0.10...23.0.11) (2026-08-07)

### Features

* **axir:** clear portable provider backlog ([486d7fb](https://github.com/ax-llm/ax/commit/486d7fbe7855be0fd50801d1d12c0acc2240252a))

## [23.0.11](https://github.com/ax-llm/ax/compare/23.0.9...23.0.10) (2026-08-07)

### Features

* **axir:** clear portable provider backlog ([486d7fb](https://github.com/ax-llm/ax/commit/486d7fbe7855be0fd50801d1d12c0acc2240252a))

## [23.0.10](https://github.com/ax-llm/ax/compare/23.0.9...23.0.10) (2026-08-05)

### Features

* **openai:** cache breakpoints on GPT-5.6+ and cache write tokens ([#573](https://github.com/ax-llm/ax/issues/573)) ([c05b3e8](https://github.com/ax-llm/ax/commit/c05b3e8c6945c590f5114f7bb6a6ef12e9c38f3f))

### Bug Fixes

* **agent:** preserve usage after failed runs ([d67fced](https://github.com/ax-llm/ax/commit/d67fced2ea766f6ec392cdd98687b4f051fd8f45))
* **ai:** route Vertex multi-region endpoints ([5d56a88](https://github.com/ax-llm/ax/commit/5d56a887e56c30d91ed86dde92d1d9e159e96c1f))
* **util:** browser SSE streams end with a spurious network error ([#571](https://github.com/ax-llm/ax/issues/571)) ([ae0dcee](https://github.com/ax-llm/ax/commit/ae0dceed41fdcd20958942b0a090c22580333712))

## [23.0.10](https://github.com/ax-llm/ax/compare/23.0.8...23.0.9) (2026-08-05)

### Features

* **openai:** cache breakpoints on GPT-5.6+ and cache write tokens ([#573](https://github.com/ax-llm/ax/issues/573)) ([c05b3e8](https://github.com/ax-llm/ax/commit/c05b3e8c6945c590f5114f7bb6a6ef12e9c38f3f))

### Bug Fixes

* **agent:** preserve usage after failed runs ([d67fced](https://github.com/ax-llm/ax/commit/d67fced2ea766f6ec392cdd98687b4f051fd8f45))
* **ai:** route Vertex multi-region endpoints ([5d56a88](https://github.com/ax-llm/ax/commit/5d56a887e56c30d91ed86dde92d1d9e159e96c1f))
* **util:** browser SSE streams end with a spurious network error ([#571](https://github.com/ax-llm/ax/issues/571)) ([ae0dcee](https://github.com/ax-llm/ax/commit/ae0dceed41fdcd20958942b0a090c22580333712))

## [23.0.9](https://github.com/ax-llm/ax/compare/23.0.8...23.0.9) (2026-07-31)

### Features

* **axir:** map GPT-5.6 reasoning effort ([f9d6ae3](https://github.com/ax-llm/ax/commit/f9d6ae3affdc505cf0c0880a8173a057b512c9d2))
* **axir:** port MCP inbound requests and task input ([09a14ad](https://github.com/ax-llm/ax/commit/09a14addf945ac4c91abb824113c358f966f2e70))
* **axir:** port URL arrays and structured stream deltas ([65b1432](https://github.com/ax-llm/ax/commit/65b14323c079975575823722214e0ecdf0bec61f))

### Bug Fixes

* **axir:** publish cleared backlog capabilities ([87ef028](https://github.com/ax-llm/ax/commit/87ef028ca533de39f27185d4d7b1b120a8d71b1c))
* **axir:** split GPT-5.6 reasoning surfaces ([f76a950](https://github.com/ax-llm/ax/commit/f76a950d40fdadb0ae401445a4229157595fb43e))

## [23.0.9](https://github.com/ax-llm/ax/compare/23.0.7...23.0.8) (2026-07-31)

### Features

* **axir:** map GPT-5.6 reasoning effort ([f9d6ae3](https://github.com/ax-llm/ax/commit/f9d6ae3affdc505cf0c0880a8173a057b512c9d2))
* **axir:** port MCP inbound requests and task input ([09a14ad](https://github.com/ax-llm/ax/commit/09a14addf945ac4c91abb824113c358f966f2e70))
* **axir:** port URL arrays and structured stream deltas ([65b1432](https://github.com/ax-llm/ax/commit/65b14323c079975575823722214e0ecdf0bec61f))

### Bug Fixes

* **axir:** publish cleared backlog capabilities ([87ef028](https://github.com/ax-llm/ax/commit/87ef028ca533de39f27185d4d7b1b120a8d71b1c))
* **axir:** split GPT-5.6 reasoning surfaces ([f76a950](https://github.com/ax-llm/ax/commit/f76a950d40fdadb0ae401445a4229157595fb43e))

## [23.0.8](https://github.com/ax-llm/ax/compare/23.0.7...23.0.8) (2026-07-31)

### Bug Fixes

* **openai:** stop sending max reasoning effort on the chat path ([#569](https://github.com/ax-llm/ax/issues/569)) ([d749bdd](https://github.com/ax-llm/ax/commit/d749bdd38df2884a64e117641349c7c4536270b2))

## [23.0.8](https://github.com/ax-llm/ax/compare/23.0.6...23.0.7) (2026-07-31)

### Bug Fixes

* **openai:** stop sending max reasoning effort on the chat path ([#569](https://github.com/ax-llm/ax/issues/569)) ([d749bdd](https://github.com/ax-llm/ax/commit/d749bdd38df2884a64e117641349c7c4536270b2))

## [23.0.7](https://github.com/ax-llm/ax/compare/23.0.6...23.0.7) (2026-07-31)

### Features

* **axir:** add modern MCP semantic foundations ([75ae884](https://github.com/ax-llm/ax/commit/75ae884cbb268037926dd4a266da30321bbff011))
* **axir:** port actor multi-fence rejection ([e872fbb](https://github.com/ax-llm/ax/commit/e872fbb994e0c2ed22c2136756420806c959fd8a))
* **axir:** port dual-era MCP client ([e43afb3](https://github.com/ax-llm/ax/commit/e43afb35854c370a637f13acf416668f263c7efb))
* **axir:** port managed Gemini context caching ([e843410](https://github.com/ax-llm/ax/commit/e8434104a87b536dad1d19ecd2b036cf24960b27))
* **axir:** port MCP cacheable results ([2067e57](https://github.com/ax-llm/ax/commit/2067e579c0147530133e59ecc115b3a5c02b6990))
* **axir:** port MCP OAuth issuer validation ([82272c5](https://github.com/ax-llm/ax/commit/82272c59c56a083e80f44e941ff1637acd5d10af))
* **axir:** port MCP subscriptions listen ([400092a](https://github.com/ax-llm/ax/commit/400092a28d43f10fd876e59c90e92d699110ef1c))
* **axir:** port MCP Tasks v2 ([bfe2f5a](https://github.com/ax-llm/ax/commit/bfe2f5ab07bd1c815534cf631fc057b05bfd7758))
* **axir:** port modern MCP transport headers ([afaae69](https://github.com/ax-llm/ax/commit/afaae6931c3d9911ef6e4399ac3df3c0ee402f19))
* **axir:** port roots-first MCP MRTR ([0935411](https://github.com/ax-llm/ax/commit/093541147aa43ff543cd0befc2f8c6b749ff81af))
* **axir:** verify modern MCP round trips ([c6253f5](https://github.com/ax-llm/ax/commit/c6253f57ebdb3f5d4359338a7f32366b02de9665))
* **mcp:** add 2026-07-28 protocol types ([dceed8b](https://github.com/ax-llm/ax/commit/dceed8b45870325f80bb82551e5662cf09e11d10))
* **mcp:** add dual-era stateless client core ([d5c3b5f](https://github.com/ax-llm/ax/commit/d5c3b5f97f0e2d4d239cab000c5d4b869d8ddc3a))
* **mcp:** add modern transport header plumbing ([4b3bf5b](https://github.com/ax-llm/ax/commit/4b3bf5b3b4172616c7600c928b80352e31079a07))
* **mcp:** add schema-driven parameter headers ([f55a529](https://github.com/ax-llm/ax/commit/f55a5297d68b20c3365357b74623a41806d8e623))
* **mcp:** add subscriptions and cache TTL ([2907843](https://github.com/ax-llm/ax/commit/29078437badf25fed3e1b7ead3812b61a972d169))
* **mcp:** add tasks extension v2 ([5ac2f72](https://github.com/ax-llm/ax/commit/5ac2f72e8b68c2999f248d29213fbd9735f67841))
* **mcp:** add typed protocol and oauth issuer errors ([933fe0a](https://github.com/ax-llm/ax/commit/933fe0a8d780f5d31d49fdb079b38897062951b5))
* **mcp:** define modern port boundaries ([db2714d](https://github.com/ax-llm/ax/commit/db2714d0729d223dc2b3af8b318d82684fed5567))
* **mcp:** document dual-era client ([4d479b9](https://github.com/ax-llm/ax/commit/4d479b97f933b977c6c79d98fe2fc4b984fb7b96))
* **mcp:** port MRTR elicitation ([f053c73](https://github.com/ax-llm/ax/commit/f053c737285a7a6dea38f9b653fb601d402d4658))
* **mcp:** port OAuth discovery and grants ([ca86192](https://github.com/ax-llm/ax/commit/ca8619226fe91d893f0e5b51c3ce76a774057456))
* **mcp:** support multi round-trip requests ([2bb681f](https://github.com/ax-llm/ax/commit/2bb681f310bce68d46c45fb24279fde3b3e4e686))
* **openai:** add GPT-5.6 model family support ([#568](https://github.com/ax-llm/ax/issues/568)) ([0bbccda](https://github.com/ax-llm/ax/commit/0bbccdac3c9d789dd12d62286a63c191233837a8))

### Bug Fixes

* **mcp:** validate subscription acknowledgements ([42377de](https://github.com/ax-llm/ax/commit/42377de43c399892593864dd86bd43c4eec3cee4))
* stop duplicating object array items when streaming structured output ([#565](https://github.com/ax-llm/ax/issues/565)) ([f414c6d](https://github.com/ax-llm/ax/commit/f414c6d7b7038e611bc0d3f66b633a14d65aadd3)), closes [#564](https://github.com/ax-llm/ax/issues/564) [#568](https://github.com/ax-llm/ax/issues/568)
* validate url arrays per-item instead of on the whole array ([#567](https://github.com/ax-llm/ax/issues/567)) ([87a6720](https://github.com/ax-llm/ax/commit/87a6720829b6937909ecc6da6cae993de4c5a73c))

## [23.0.7](https://github.com/ax-llm/ax/compare/23.0.5...23.0.6) (2026-07-31)

### Features

* **axir:** add modern MCP semantic foundations ([75ae884](https://github.com/ax-llm/ax/commit/75ae884cbb268037926dd4a266da30321bbff011))
* **axir:** port actor multi-fence rejection ([e872fbb](https://github.com/ax-llm/ax/commit/e872fbb994e0c2ed22c2136756420806c959fd8a))
* **axir:** port dual-era MCP client ([e43afb3](https://github.com/ax-llm/ax/commit/e43afb35854c370a637f13acf416668f263c7efb))
* **axir:** port managed Gemini context caching ([e843410](https://github.com/ax-llm/ax/commit/e8434104a87b536dad1d19ecd2b036cf24960b27))
* **axir:** port MCP cacheable results ([2067e57](https://github.com/ax-llm/ax/commit/2067e579c0147530133e59ecc115b3a5c02b6990))
* **axir:** port MCP OAuth issuer validation ([82272c5](https://github.com/ax-llm/ax/commit/82272c59c56a083e80f44e941ff1637acd5d10af))
* **axir:** port MCP subscriptions listen ([400092a](https://github.com/ax-llm/ax/commit/400092a28d43f10fd876e59c90e92d699110ef1c))
* **axir:** port MCP Tasks v2 ([bfe2f5a](https://github.com/ax-llm/ax/commit/bfe2f5ab07bd1c815534cf631fc057b05bfd7758))
* **axir:** port modern MCP transport headers ([afaae69](https://github.com/ax-llm/ax/commit/afaae6931c3d9911ef6e4399ac3df3c0ee402f19))
* **axir:** port roots-first MCP MRTR ([0935411](https://github.com/ax-llm/ax/commit/093541147aa43ff543cd0befc2f8c6b749ff81af))
* **axir:** verify modern MCP round trips ([c6253f5](https://github.com/ax-llm/ax/commit/c6253f57ebdb3f5d4359338a7f32366b02de9665))
* **mcp:** add 2026-07-28 protocol types ([dceed8b](https://github.com/ax-llm/ax/commit/dceed8b45870325f80bb82551e5662cf09e11d10))
* **mcp:** add dual-era stateless client core ([d5c3b5f](https://github.com/ax-llm/ax/commit/d5c3b5f97f0e2d4d239cab000c5d4b869d8ddc3a))
* **mcp:** add modern transport header plumbing ([4b3bf5b](https://github.com/ax-llm/ax/commit/4b3bf5b3b4172616c7600c928b80352e31079a07))
* **mcp:** add schema-driven parameter headers ([f55a529](https://github.com/ax-llm/ax/commit/f55a5297d68b20c3365357b74623a41806d8e623))
* **mcp:** add subscriptions and cache TTL ([2907843](https://github.com/ax-llm/ax/commit/29078437badf25fed3e1b7ead3812b61a972d169))
* **mcp:** add tasks extension v2 ([5ac2f72](https://github.com/ax-llm/ax/commit/5ac2f72e8b68c2999f248d29213fbd9735f67841))
* **mcp:** add typed protocol and oauth issuer errors ([933fe0a](https://github.com/ax-llm/ax/commit/933fe0a8d780f5d31d49fdb079b38897062951b5))
* **mcp:** define modern port boundaries ([db2714d](https://github.com/ax-llm/ax/commit/db2714d0729d223dc2b3af8b318d82684fed5567))
* **mcp:** document dual-era client ([4d479b9](https://github.com/ax-llm/ax/commit/4d479b97f933b977c6c79d98fe2fc4b984fb7b96))
* **mcp:** port MRTR elicitation ([f053c73](https://github.com/ax-llm/ax/commit/f053c737285a7a6dea38f9b653fb601d402d4658))
* **mcp:** port OAuth discovery and grants ([ca86192](https://github.com/ax-llm/ax/commit/ca8619226fe91d893f0e5b51c3ce76a774057456))
* **mcp:** support multi round-trip requests ([2bb681f](https://github.com/ax-llm/ax/commit/2bb681f310bce68d46c45fb24279fde3b3e4e686))
* **openai:** add GPT-5.6 model family support ([#568](https://github.com/ax-llm/ax/issues/568)) ([0bbccda](https://github.com/ax-llm/ax/commit/0bbccdac3c9d789dd12d62286a63c191233837a8))

### Bug Fixes

* **mcp:** validate subscription acknowledgements ([42377de](https://github.com/ax-llm/ax/commit/42377de43c399892593864dd86bd43c4eec3cee4))
* stop duplicating object array items when streaming structured output ([#565](https://github.com/ax-llm/ax/issues/565)) ([f414c6d](https://github.com/ax-llm/ax/commit/f414c6d7b7038e611bc0d3f66b633a14d65aadd3)), closes [#564](https://github.com/ax-llm/ax/issues/564) [#568](https://github.com/ax-llm/ax/issues/568)
* validate url arrays per-item instead of on the whole array ([#567](https://github.com/ax-llm/ax/issues/567)) ([87a6720](https://github.com/ax-llm/ax/commit/87a6720829b6937909ecc6da6cae993de4c5a73c))

## [23.0.6](https://github.com/ax-llm/ax/compare/23.0.5...23.0.6) (2026-07-29)

### Bug Fixes

* **agent:** reject multiple code blocks per turn ([#563](https://github.com/ax-llm/ax/issues/563)) ([1ef0968](https://github.com/ax-llm/ax/commit/1ef0968cc0b7bd26ec6c0506e929834d2ff837af))
* **ai:** recover from stale context caches ([906d8c5](https://github.com/ax-llm/ax/commit/906d8c5785c4f388c19ae5c3730274a95617753f))

## [23.0.6](https://github.com/ax-llm/ax/compare/23.0.4...23.0.5) (2026-07-29)

### Bug Fixes

* **agent:** reject multiple code blocks per turn ([#563](https://github.com/ax-llm/ax/issues/563)) ([1ef0968](https://github.com/ax-llm/ax/commit/1ef0968cc0b7bd26ec6c0506e929834d2ff837af))
* **ai:** recover from stale context caches ([906d8c5](https://github.com/ax-llm/ax/commit/906d8c5785c4f388c19ae5c3730274a95617753f))

## [23.0.5](https://github.com/ax-llm/ax/compare/23.0.4...23.0.5) (2026-07-24)

### Bug Fixes

* **agent:** preserve usage context in internal summaries ([0d10c43](https://github.com/ax-llm/ax/commit/0d10c4308fc48d8d77e700bc36c649f9cef84b24))

## [23.0.5](https://github.com/ax-llm/ax/compare/23.0.3...23.0.4) (2026-07-24)

### Bug Fixes

* **agent:** preserve usage context in internal summaries ([0d10c43](https://github.com/ax-llm/ax/commit/0d10c4308fc48d8d77e700bc36c649f9cef84b24))

## [23.0.4](https://github.com/ax-llm/ax/compare/23.0.3...23.0.4) (2026-07-23)

### Features

* **ai:** add adaptive balancer routing ([0f26c05](https://github.com/ax-llm/ax/commit/0f26c05ef2201b9c97b981510d89d38d56be4928))
* **ai:** add portable global usage observer ([4ad1a33](https://github.com/ax-llm/ax/commit/4ad1a3307c988cb4a74dc3ea874255d24368b095))
* **axir:** enforce AxAgent semantic parity ([7d4947a](https://github.com/ax-llm/ax/commit/7d4947aa1097348dac170a80f73c6bf4601ff65e))
* **axir:** port adaptive balancer routing ([1b74dc0](https://github.com/ax-llm/ax/commit/1b74dc0c59a5be34fc7f7ed5265c2bf0382146bf))

### Bug Fixes

* **axir:** refresh agent parity inventory ([52a26bb](https://github.com/ax-llm/ax/commit/52a26bb30f48566ad23bdd3ad78779a760515b2f))
* **ci:** add adaptive routing spelling terms ([59ac880](https://github.com/ax-llm/ax/commit/59ac880d2d851257ba1ae3c1ce295c1592e5ebfd))

## [23.0.4](https://github.com/ax-llm/ax/compare/23.0.2...23.0.3) (2026-07-23)

### Features

* **ai:** add adaptive balancer routing ([0f26c05](https://github.com/ax-llm/ax/commit/0f26c05ef2201b9c97b981510d89d38d56be4928))
* **ai:** add portable global usage observer ([4ad1a33](https://github.com/ax-llm/ax/commit/4ad1a3307c988cb4a74dc3ea874255d24368b095))
* **axir:** enforce AxAgent semantic parity ([7d4947a](https://github.com/ax-llm/ax/commit/7d4947aa1097348dac170a80f73c6bf4601ff65e))
* **axir:** port adaptive balancer routing ([1b74dc0](https://github.com/ax-llm/ax/commit/1b74dc0c59a5be34fc7f7ed5265c2bf0382146bf))

### Bug Fixes

* **axir:** refresh agent parity inventory ([52a26bb](https://github.com/ax-llm/ax/commit/52a26bb30f48566ad23bdd3ad78779a760515b2f))
* **ci:** add adaptive routing spelling terms ([59ac880](https://github.com/ax-llm/ax/commit/59ac880d2d851257ba1ae3c1ce295c1592e5ebfd))

## [23.0.3](https://github.com/ax-llm/ax/compare/23.0.2...23.0.3) (2026-07-21)

### Features

* **axir:** port new Gemini Flash models ([d25acf2](https://github.com/ax-llm/ax/commit/d25acf280d7f7e8c8a44cc93bab813af9dacf766))
* **gemini:** add 3.6 Flash and 3.5 Flash-Lite ([3fb5a8a](https://github.com/ax-llm/ax/commit/3fb5a8a41b5aab69a826e5ec4722360226dc1bec))

## [23.0.3](https://github.com/ax-llm/ax/compare/23.0.1...23.0.2) (2026-07-21)

### Features

* **axir:** port new Gemini Flash models ([d25acf2](https://github.com/ax-llm/ax/commit/d25acf280d7f7e8c8a44cc93bab813af9dacf766))
* **gemini:** add 3.6 Flash and 3.5 Flash-Lite ([3fb5a8a](https://github.com/ax-llm/ax/commit/3fb5a8a41b5aab69a826e5ec4722360226dc1bec))

## [23.0.2](https://github.com/ax-llm/ax/compare/23.0.1...23.0.2) (2026-07-21)

### ⚠ BREAKING CHANGES

* remove flow.fromMermaid/toMermaid — flow(text) and toString() are the API

### Features

* accept mermaid text in flow() and render flows via toString() ([f83bbf7](https://github.com/ax-llm/ax/commit/f83bbf72e91b75faa45befcc6f1a3e619776c1fc))
* add MCP catalog subscriptions and event runtime ([669d22f](https://github.com/ax-llm/ax/commit/669d22f50fd683c057a77584b7e2a361635fce2a))
* add multilingual Ax Academy ([1535efa](https://github.com/ax-llm/ax/commit/1535efa4fd2b30e7d129cf1ab5126b95f2f7727b))
* **axir:** port ACE shape guard, playbook attach, citations, stage instruction, verified evolve, anthropic adaptive fixes ([1e1e849](https://github.com/ax-llm/ax/commit/1e1e849eb2c09f36068f15f885e2f0e66fddf68d))
* **axir:** port extended signature grammar ([08d6494](https://github.com/ax-llm/ax/commit/08d64949a801a03ae531352a29e4406c7d053112))
* **axir:** port flow mermaid dialect ([3e88dbf](https://github.com/ax-llm/ax/commit/3e88dbf0fd850fe91bdff6d2fbf9df44fc249ef2))
* compile mermaid flowcharts into runnable flows via flow.fromMermaid() ([7702484](https://github.com/ax-llm/ax/commit/7702484f106d7ace5392c43bf1a5ac396948afdc))
* deepen Ax Academy mastery learning ([7cd788c](https://github.com/ax-llm/ax/commit/7cd788c0fb2e877d59b396960a7492a748e12462))
* **event:** add conforming SQLite event store ([c285545](https://github.com/ax-llm/ax/commit/c2855458b00409187ff366f2486465db09129626))
* **event:** add verified UCP webhook runtime ([a45be52](https://github.com/ax-llm/ax/commit/a45be52e82e2f8f9569929692544ea4579e17811))
* **event:** add volatile AxEventRuntime core ([4785634](https://github.com/ax-llm/ax/commit/47856347b35aed15f2ec0f7884c235f0868c3f88))
* **event:** bridge MCP notifications and tasks ([0a9a35d](https://github.com/ax-llm/ax/commit/0a9a35d3b5c5e09398c16f805c0fe25a0810ffb1))
* **event:** port deterministic runtime through AxIR ([f4aad7a](https://github.com/ax-llm/ax/commit/f4aad7ac0a10cb7d8c7484b52c8d72be7243caa0))
* extend signature string grammar with modifier bags and nested objects ([2f6b422](https://github.com/ax-llm/ax/commit/2f6b42236de482fda6e711d3f0e613ce285fcfff))
* infer extended signature grammar at the type level ([e7a8e3a](https://github.com/ax-llm/ax/commit/e7a8e3a8445f1611807d2d8e2447c7fa95534f93))
* make Ax Academy newbie-first ([e064894](https://github.com/ax-llm/ax/commit/e0648944a2d9074847a42e0a79cb0c14bceb6f89))
* **mcp:** add native MCP and UCP execution ([9c05203](https://github.com/ax-llm/ax/commit/9c0520371669a553eed605351fdd5417a734da1f))
* preserve isOptional and class-option unions in signature field-addition types ([766bd99](https://github.com/ax-llm/ax/commit/766bd99c020e78008cf9a32de3fa5a8dfa9a852e))
* remove flow.fromMermaid/toMermaid — flow(text) and toString() are the API ([f066578](https://github.com/ax-llm/ax/commit/f0665780ed244d613c73bbb1ab2a607117bb7a50))
* render AxFlow as mermaid via toMermaid() ([8ae55b4](https://github.com/ax-llm/ax/commit/8ae55b41746b488e682765e0edb9b1c8e93ede98))

### Bug Fixes

* accept any whitespace after the description in type-level signatures ([f283f2e](https://github.com/ax-llm/ax/commit/f283f2e0bf7cd0cbfd31d1b877744fb4c8164eda))
* accept any whitespace around -> in the type-level signature splitter ([91c072f](https://github.com/ax-llm/ax/commit/91c072f7f5e5e3109cdc5403771b484396bdc15f))
* bump the academy page lockstep count in the website link checker ([25ebc12](https://github.com/ax-llm/ax/commit/25ebc128a1279e29d8bb0554885ee421c2efcfab))
* clarify Ax Academy headline ([790637c](https://github.com/ax-llm/ax/commit/790637c40898beeb44f395b4b390941b865bfbef))
* **docs:** make the subsystem-s mermaid example's class field output-only ([6b68661](https://github.com/ax-llm/ax/commit/6b6866147922076f09776de4f32fd9132a126f35))
* enforce Academy question API coverage ([fd7dcb0](https://github.com/ax-llm/ax/commit/fd7dcb0c1e11415b3340b7fe2ca7b925d69f79be))
* **event:** complete runtime landing repair ([4771325](https://github.com/ax-llm/ax/commit/47713253fd742e849d6c13b05e12b83fb9b31509))
* **flow:** see through branch/while steps in signature inference ([d4b5246](https://github.com/ax-llm/ax/commit/d4b524635e22b6ee00d91dfee491dcec23025fb3))
* polish Academy lesson states ([31f293d](https://github.com/ax-llm/ax/commit/31f293d0ebe925f398e3310055e4d2b6ef3b1b2e))
* repair event runtime CI build ([8ef7d05](https://github.com/ax-llm/ax/commit/8ef7d055642b98356f2ad7afd41446c9433e3bf4))
* reword comment for spelling gate ([27e2273](https://github.com/ax-llm/ax/commit/27e2273992c4379b317ab9e575a8ca6f859b7094))
* silence unused-variable lint warning in mermaid node resolution ([471f129](https://github.com/ax-llm/ax/commit/471f129ce1daf383f66fba2be2bd9f043eb5add2))
* simplify Ax Academy hero layout ([478c21d](https://github.com/ax-llm/ax/commit/478c21da2040be7c3d50540bb84f28f608cfa7eb))
* **test:** migrate concurrent inference-fix regression tests off removed fromMermaid ([be74a16](https://github.com/ax-llm/ax/commit/be74a16dd6f194390a6b44d421865786a6008db4))

### Reverts

* Revert "chore(axir): drop mermaid + extended-grammar ports-parity entries" ([9e73091](https://github.com/ax-llm/ax/commit/9e73091398c1ffb5b4f4acaf13eccb947211ecbe))

## [23.0.2](https://github.com/ax-llm/ax/compare/23.0.0...23.0.1) (2026-07-21)

### ⚠ BREAKING CHANGES

* remove flow.fromMermaid/toMermaid — flow(text) and toString() are the API

### Features

* accept mermaid text in flow() and render flows via toString() ([f83bbf7](https://github.com/ax-llm/ax/commit/f83bbf72e91b75faa45befcc6f1a3e619776c1fc))
* add MCP catalog subscriptions and event runtime ([669d22f](https://github.com/ax-llm/ax/commit/669d22f50fd683c057a77584b7e2a361635fce2a))
* add multilingual Ax Academy ([1535efa](https://github.com/ax-llm/ax/commit/1535efa4fd2b30e7d129cf1ab5126b95f2f7727b))
* **axir:** port ACE shape guard, playbook attach, citations, stage instruction, verified evolve, anthropic adaptive fixes ([1e1e849](https://github.com/ax-llm/ax/commit/1e1e849eb2c09f36068f15f885e2f0e66fddf68d))
* **axir:** port extended signature grammar ([08d6494](https://github.com/ax-llm/ax/commit/08d64949a801a03ae531352a29e4406c7d053112))
* **axir:** port flow mermaid dialect ([3e88dbf](https://github.com/ax-llm/ax/commit/3e88dbf0fd850fe91bdff6d2fbf9df44fc249ef2))
* compile mermaid flowcharts into runnable flows via flow.fromMermaid() ([7702484](https://github.com/ax-llm/ax/commit/7702484f106d7ace5392c43bf1a5ac396948afdc))
* deepen Ax Academy mastery learning ([7cd788c](https://github.com/ax-llm/ax/commit/7cd788c0fb2e877d59b396960a7492a748e12462))
* **event:** add conforming SQLite event store ([c285545](https://github.com/ax-llm/ax/commit/c2855458b00409187ff366f2486465db09129626))
* **event:** add verified UCP webhook runtime ([a45be52](https://github.com/ax-llm/ax/commit/a45be52e82e2f8f9569929692544ea4579e17811))
* **event:** add volatile AxEventRuntime core ([4785634](https://github.com/ax-llm/ax/commit/47856347b35aed15f2ec0f7884c235f0868c3f88))
* **event:** bridge MCP notifications and tasks ([0a9a35d](https://github.com/ax-llm/ax/commit/0a9a35d3b5c5e09398c16f805c0fe25a0810ffb1))
* **event:** port deterministic runtime through AxIR ([f4aad7a](https://github.com/ax-llm/ax/commit/f4aad7ac0a10cb7d8c7484b52c8d72be7243caa0))
* extend signature string grammar with modifier bags and nested objects ([2f6b422](https://github.com/ax-llm/ax/commit/2f6b42236de482fda6e711d3f0e613ce285fcfff))
* infer extended signature grammar at the type level ([e7a8e3a](https://github.com/ax-llm/ax/commit/e7a8e3a8445f1611807d2d8e2447c7fa95534f93))
* make Ax Academy newbie-first ([e064894](https://github.com/ax-llm/ax/commit/e0648944a2d9074847a42e0a79cb0c14bceb6f89))
* **mcp:** add native MCP and UCP execution ([9c05203](https://github.com/ax-llm/ax/commit/9c0520371669a553eed605351fdd5417a734da1f))
* preserve isOptional and class-option unions in signature field-addition types ([766bd99](https://github.com/ax-llm/ax/commit/766bd99c020e78008cf9a32de3fa5a8dfa9a852e))
* remove flow.fromMermaid/toMermaid — flow(text) and toString() are the API ([f066578](https://github.com/ax-llm/ax/commit/f0665780ed244d613c73bbb1ab2a607117bb7a50))
* render AxFlow as mermaid via toMermaid() ([8ae55b4](https://github.com/ax-llm/ax/commit/8ae55b41746b488e682765e0edb9b1c8e93ede98))

### Bug Fixes

* accept any whitespace after the description in type-level signatures ([f283f2e](https://github.com/ax-llm/ax/commit/f283f2e0bf7cd0cbfd31d1b877744fb4c8164eda))
* accept any whitespace around -> in the type-level signature splitter ([91c072f](https://github.com/ax-llm/ax/commit/91c072f7f5e5e3109cdc5403771b484396bdc15f))
* bump the academy page lockstep count in the website link checker ([25ebc12](https://github.com/ax-llm/ax/commit/25ebc128a1279e29d8bb0554885ee421c2efcfab))
* clarify Ax Academy headline ([790637c](https://github.com/ax-llm/ax/commit/790637c40898beeb44f395b4b390941b865bfbef))
* **docs:** make the subsystem-s mermaid example's class field output-only ([6b68661](https://github.com/ax-llm/ax/commit/6b6866147922076f09776de4f32fd9132a126f35))
* enforce Academy question API coverage ([fd7dcb0](https://github.com/ax-llm/ax/commit/fd7dcb0c1e11415b3340b7fe2ca7b925d69f79be))
* **event:** complete runtime landing repair ([4771325](https://github.com/ax-llm/ax/commit/47713253fd742e849d6c13b05e12b83fb9b31509))
* **flow:** see through branch/while steps in signature inference ([d4b5246](https://github.com/ax-llm/ax/commit/d4b524635e22b6ee00d91dfee491dcec23025fb3))
* polish Academy lesson states ([31f293d](https://github.com/ax-llm/ax/commit/31f293d0ebe925f398e3310055e4d2b6ef3b1b2e))
* repair event runtime CI build ([8ef7d05](https://github.com/ax-llm/ax/commit/8ef7d055642b98356f2ad7afd41446c9433e3bf4))
* reword comment for spelling gate ([27e2273](https://github.com/ax-llm/ax/commit/27e2273992c4379b317ab9e575a8ca6f859b7094))
* silence unused-variable lint warning in mermaid node resolution ([471f129](https://github.com/ax-llm/ax/commit/471f129ce1daf383f66fba2be2bd9f043eb5add2))
* simplify Ax Academy hero layout ([478c21d](https://github.com/ax-llm/ax/commit/478c21da2040be7c3d50540bb84f28f608cfa7eb))
* **test:** migrate concurrent inference-fix regression tests off removed fromMermaid ([be74a16](https://github.com/ax-llm/ax/commit/be74a16dd6f194390a6b44d421865786a6008db4))

### Reverts

* Revert "chore(axir): drop mermaid + extended-grammar ports-parity entries" ([9e73091](https://github.com/ax-llm/ax/commit/9e73091398c1ffb5b4f4acaf13eccb947211ecbe))

## [23.0.1](https://github.com/ax-llm/ax/compare/23.0.0...23.0.1) (2026-07-14)

### Features

* **agent:** agent.improve() — failure-driven repair with regression-validated acceptance ([994aac0](https://github.com/ax-llm/ax/commit/994aac0e6a7932eb02d6855f5ba8dbaf651e2f3c))
* **agent:** construction-time playbook with run-end failure learning ([87be227](https://github.com/ax-llm/ax/commit/87be2273faca24a14e3a4704e42b0477c8dac29c))
* **agent:** opt-in chain-of-evidence citations on the responder ([12fe8d0](https://github.com/ax-llm/ax/commit/12fe8d0b81f256b482dbdc782dffa3879e5f971f))
* **website:** keep docs side-nav position across pages; chain next page on scroll ([f4f16fc](https://github.com/ax-llm/ax/commit/f4f16fc1c854353b3adf0399ce2936f04d2e9f00))
* **website:** rework homepage top of page around the real moat ([5ef34b7](https://github.com/ax-llm/ax/commit/5ef34b743dbd987aac053f20c8befedb0624181d))

### Bug Fixes

* **agent:** correctness fixes from adversarial review of P1-P3 ([f4d4ac8](https://github.com/ax-llm/ax/commit/f4d4ac8deb71c7e7c2be1dbaa84579892db08b98))
* **agent:** revive the dead stage ::instruction knob; playbook dedupe re-learns pruned lessons; improve() runsPerTask ([052fe52](https://github.com/ax-llm/ax/commit/052fe52d05ab80f4c008f5ee166774fbc2246289))
* **anthropic:** omit sampling params on all adaptive models, not just Opus 4.7+ ([#560](https://github.com/ax-llm/ax/issues/560)) ([10eecc9](https://github.com/ax-llm/ax/commit/10eecc9dccee135af7a7175c1f84162b64d9934c))
* **anthropic:** request summarized thinking display on adaptive models ([#561](https://github.com/ax-llm/ax/issues/561)) ([61bea23](https://github.com/ax-llm/ax/commit/61bea23f346f61a5821f347a8972c18047af037c)), closes [#560](https://github.com/ax-llm/ax/issues/560)
* **website:** stop hero example swaps from reflowing the page; calmer two-line h1 ([1758469](https://github.com/ax-llm/ax/commit/17584697655efa1b38748a89cf6651255a48d038))

## [23.0.1](https://github.com/ax-llm/ax/compare/22.0.9...23.0.0) (2026-07-14)

### Features

* **agent:** agent.improve() — failure-driven repair with regression-validated acceptance ([994aac0](https://github.com/ax-llm/ax/commit/994aac0e6a7932eb02d6855f5ba8dbaf651e2f3c))
* **agent:** construction-time playbook with run-end failure learning ([87be227](https://github.com/ax-llm/ax/commit/87be2273faca24a14e3a4704e42b0477c8dac29c))
* **agent:** opt-in chain-of-evidence citations on the responder ([12fe8d0](https://github.com/ax-llm/ax/commit/12fe8d0b81f256b482dbdc782dffa3879e5f971f))
* **website:** keep docs side-nav position across pages; chain next page on scroll ([f4f16fc](https://github.com/ax-llm/ax/commit/f4f16fc1c854353b3adf0399ce2936f04d2e9f00))
* **website:** rework homepage top of page around the real moat ([5ef34b7](https://github.com/ax-llm/ax/commit/5ef34b743dbd987aac053f20c8befedb0624181d))

### Bug Fixes

* **agent:** correctness fixes from adversarial review of P1-P3 ([f4d4ac8](https://github.com/ax-llm/ax/commit/f4d4ac8deb71c7e7c2be1dbaa84579892db08b98))
* **agent:** revive the dead stage ::instruction knob; playbook dedupe re-learns pruned lessons; improve() runsPerTask ([052fe52](https://github.com/ax-llm/ax/commit/052fe52d05ab80f4c008f5ee166774fbc2246289))
* **anthropic:** omit sampling params on all adaptive models, not just Opus 4.7+ ([#560](https://github.com/ax-llm/ax/issues/560)) ([10eecc9](https://github.com/ax-llm/ax/commit/10eecc9dccee135af7a7175c1f84162b64d9934c))
* **anthropic:** request summarized thinking display on adaptive models ([#561](https://github.com/ax-llm/ax/issues/561)) ([61bea23](https://github.com/ax-llm/ax/commit/61bea23f346f61a5821f347a8972c18047af037c)), closes [#560](https://github.com/ax-llm/ax/issues/560)
* **website:** stop hero example swaps from reflowing the page; calmer two-line h1 ([1758469](https://github.com/ax-llm/ax/commit/17584697655efa1b38748a89cf6651255a48d038))

## [23.0.0](https://github.com/ax-llm/ax/compare/22.0.9...23.0.0) (2026-07-05)

### Features

* **agent:** auto-upgrade smart defaults for discovery and context fields ([c114323](https://github.com/ax-llm/ax/commit/c1143238765bd7ae85fe17678d7013f23e6f9238))
* **agent:** direct-respond — distiller respond(task, evidence) skips the executor ([8df3c3c](https://github.com/ax-llm/ax/commit/8df3c3c2b715c70ec77441453079a089cd3ea547))
* **agent:** direct-respond live eval gate — 0 false-skips, 100% skip recall on both pinned models ([30669f1](https://github.com/ax-llm/ax/commit/30669f163981dc81928cb8cb16b937c43093b5f0))
* **agent:** shape hints in evidence descriptors and context metadata ([3306475](https://github.com/ax-llm/ax/commit/3306475085414d36aee4411ad2466e08e53bef8a))
* **agent:** shared runtime session across distiller/executor phases ([2395334](https://github.com/ax-llm/ax/commit/23953349a02a5f3b43845d69dbba99033919cf75))
* **agent:** unified relevance layer with catalog-backed search and advisory hints ([6840ab3](https://github.com/ax-llm/ax/commit/6840ab390a69bdb3e0e52a35c72c26b33b994329))
* **axir:** port agent backlog to generated packages ([d22f09d](https://github.com/ax-llm/ax/commit/d22f09d5595a221eae9a86fa5e0b76e66e9332c3))
* **axir:** port direct-respond to AxIR and all five language runtimes ([b86d16d](https://github.com/ax-llm/ax/commit/b86d16dce93ca4a8afb2d2946b38bcd54e4cf127))

### Bug Fixes

* **agent:** executor must discover before declaring data unavailable ([6c72769](https://github.com/ax-llm/ax/commit/6c727693c3b781e9471f75cd6c1d0ebe7d7d4254))
* **agent:** keep memories cache breakpoint after setSignature() ([6d7286c](https://github.com/ax-llm/ax/commit/6d7286ce8ea519f5d80bb3d75e8b2c71b76a8069))
* **axir:** stop the backlog gate crashing on large diffs; order open entries by landing date ([6f85dc9](https://github.com/ax-llm/ax/commit/6f85dc9ca057331f59baaefaf370fb113e089c58))
* **examples:** repair CI type checks ([d42d379](https://github.com/ax-llm/ax/commit/d42d379d0bb722c5602d5baa726b6dfb66589ef0))

## [23.0.0](https://github.com/ax-llm/ax/compare/22.0.8...22.0.9) (2026-07-05)

### Features

* **agent:** auto-upgrade smart defaults for discovery and context fields ([c114323](https://github.com/ax-llm/ax/commit/c1143238765bd7ae85fe17678d7013f23e6f9238))
* **agent:** direct-respond — distiller respond(task, evidence) skips the executor ([8df3c3c](https://github.com/ax-llm/ax/commit/8df3c3c2b715c70ec77441453079a089cd3ea547))
* **agent:** direct-respond live eval gate — 0 false-skips, 100% skip recall on both pinned models ([30669f1](https://github.com/ax-llm/ax/commit/30669f163981dc81928cb8cb16b937c43093b5f0))
* **agent:** shape hints in evidence descriptors and context metadata ([3306475](https://github.com/ax-llm/ax/commit/3306475085414d36aee4411ad2466e08e53bef8a))
* **agent:** shared runtime session across distiller/executor phases ([2395334](https://github.com/ax-llm/ax/commit/23953349a02a5f3b43845d69dbba99033919cf75))
* **agent:** unified relevance layer with catalog-backed search and advisory hints ([6840ab3](https://github.com/ax-llm/ax/commit/6840ab390a69bdb3e0e52a35c72c26b33b994329))
* **axir:** port agent backlog to generated packages ([d22f09d](https://github.com/ax-llm/ax/commit/d22f09d5595a221eae9a86fa5e0b76e66e9332c3))
* **axir:** port direct-respond to AxIR and all five language runtimes ([b86d16d](https://github.com/ax-llm/ax/commit/b86d16dce93ca4a8afb2d2946b38bcd54e4cf127))

### Bug Fixes

* **agent:** executor must discover before declaring data unavailable ([6c72769](https://github.com/ax-llm/ax/commit/6c727693c3b781e9471f75cd6c1d0ebe7d7d4254))
* **agent:** keep memories cache breakpoint after setSignature() ([6d7286c](https://github.com/ax-llm/ax/commit/6d7286ce8ea519f5d80bb3d75e8b2c71b76a8069))
* **axir:** stop the backlog gate crashing on large diffs; order open entries by landing date ([6f85dc9](https://github.com/ax-llm/ax/commit/6f85dc9ca057331f59baaefaf370fb113e089c58))
* **examples:** repair CI type checks ([d42d379](https://github.com/ax-llm/ax/commit/d42d379d0bb722c5602d5baa726b6dfb66589ef0))

## [22.0.9](https://github.com/ax-llm/ax/compare/22.0.8...22.0.9) (2026-06-30)

### Features

* **anthropic:** add Claude Sonnet 5 support ([#558](https://github.com/ax-llm/ax/issues/558)) ([811dee8](https://github.com/ax-llm/ax/commit/811dee880ff6a52f6432812f045029ea2fbe9ba0))

### Bug Fixes

* add AxIR terms to spelling dictionary ([592b7fb](https://github.com/ax-llm/ax/commit/592b7fbe39a7acca265b5c947e4ed69bb3190ca8))

## [22.0.9](https://github.com/ax-llm/ax/compare/22.0.7...22.0.8) (2026-06-30)

### Features

* **anthropic:** add Claude Sonnet 5 support ([#558](https://github.com/ax-llm/ax/issues/558)) ([811dee8](https://github.com/ax-llm/ax/commit/811dee880ff6a52f6432812f045029ea2fbe9ba0))

### Bug Fixes

* add AxIR terms to spelling dictionary ([592b7fb](https://github.com/ax-llm/ax/commit/592b7fbe39a7acca265b5c947e4ed69bb3190ca8))

## [22.0.8](https://github.com/ax-llm/ax/compare/22.0.7...22.0.8) (2026-06-30)

### Features

* add AI SDK v7 support ([#557](https://github.com/ax-llm/ax/issues/557)) ([ec940f8](https://github.com/ax-llm/ax/commit/ec940f80b792f9e302b1319ed6215d8294ff5f4d))
* **axir:** assert balancer streaming failover + close [#556](https://github.com/ax-llm/ax/issues/556) transient-error port ([57df89b](https://github.com/ax-llm/ax/commit/57df89bc62329bb99da941964eef5d1590f7c2d5))
* **axir:** port Anthropic transient-error classification + 529 retryability + streaming-overload retry ([4f4f8c0](https://github.com/ax-llm/ax/commit/4f4f8c02528466d8215d51bb472d26f0a5140270)), closes [#556](https://github.com/ax-llm/ax/issues/556)
* **axir:** port the playbook (ACE) optimizer to all 5 generated languages ([968a906](https://github.com/ax-llm/ax/commit/968a9067352143523b28b6668370db39faf492c9))
* **dsp:** add playbook() concept that wraps the ACE optimizer ([858d55f](https://github.com/ax-llm/ax/commit/858d55f3d3f1af5ad403fe0019e4da3e7528b32a))
* restore WebLLM provider and ACE optimizer ([d536956](https://github.com/ax-llm/ax/commit/d53695673c4a837c114557bbd89f2100ed035a22))

### Bug Fixes

* **agent:** recover from empty model turns and unknown tool calls ([8a44919](https://github.com/ax-llm/ax/commit/8a44919a97a829ab800b3a73a933f6a9bdc4e00e))
* **axir:** playbook reflector/curator need field descriptions to learn live ([5173dfa](https://github.com/ax-llm/ax/commit/5173dfa1434f854ba097716c95c1691391b7cd27))
* **axir:** port agent recovery fixes to generated packages ([05a9a26](https://github.com/ax-llm/ax/commit/05a9a2653f6b08ad304d06ce00e90f8a5f782a2b))
* **axir:** regenerate ports for the ACE curator no-op filter ([7c299d6](https://github.com/ax-llm/ax/commit/7c299d6f63fe3dafcdc6c9dac012c3355170f390))
* **axir:** Rust + Go agent-API parity (AxGen-backed) + G9 public-API parity gate ([42ad3e2](https://github.com/ax-llm/ax/commit/42ad3e2a75c719c919238368fb9b11f7d75238e2))
* **bedrock:** read Titan embedding dimensions from config (axir-no-impact) ([#550](https://github.com/ax-llm/ax/issues/550)) ([2c37bc1](https://github.com/ax-llm/ax/commit/2c37bc1a46552fce1cad40017c579b926d5edc85))
* **dsp:** AxACE must not let undefined option values clobber defaults ([f37b44a](https://github.com/ax-llm/ax/commit/f37b44a75322be3dd53b2def7fc31f7a497006eb))
* **dsp:** drop no-op acknowledgment bullets from the ACE curator ([be3382c](https://github.com/ax-llm/ax/commit/be3382c57b308f7ee84f873e16bf6b6709219b0d))
* **gepa:** prefer an accepted evolution over the seed it ties ([#546](https://github.com/ax-llm/ax/issues/546)) ([f260976](https://github.com/ax-llm/ax/commit/f260976a83d2e1dccb7f5e4a13caac3fa243d934))

## [22.0.8](https://github.com/ax-llm/ax/compare/22.0.6...22.0.7) (2026-06-30)

### Features

* add AI SDK v7 support ([#557](https://github.com/ax-llm/ax/issues/557)) ([ec940f8](https://github.com/ax-llm/ax/commit/ec940f80b792f9e302b1319ed6215d8294ff5f4d))
* **axir:** assert balancer streaming failover + close [#556](https://github.com/ax-llm/ax/issues/556) transient-error port ([57df89b](https://github.com/ax-llm/ax/commit/57df89bc62329bb99da941964eef5d1590f7c2d5))
* **axir:** port Anthropic transient-error classification + 529 retryability + streaming-overload retry ([4f4f8c0](https://github.com/ax-llm/ax/commit/4f4f8c02528466d8215d51bb472d26f0a5140270)), closes [#556](https://github.com/ax-llm/ax/issues/556)
* **axir:** port the playbook (ACE) optimizer to all 5 generated languages ([968a906](https://github.com/ax-llm/ax/commit/968a9067352143523b28b6668370db39faf492c9))
* **dsp:** add playbook() concept that wraps the ACE optimizer ([858d55f](https://github.com/ax-llm/ax/commit/858d55f3d3f1af5ad403fe0019e4da3e7528b32a))
* restore WebLLM provider and ACE optimizer ([d536956](https://github.com/ax-llm/ax/commit/d53695673c4a837c114557bbd89f2100ed035a22))

### Bug Fixes

* **agent:** recover from empty model turns and unknown tool calls ([8a44919](https://github.com/ax-llm/ax/commit/8a44919a97a829ab800b3a73a933f6a9bdc4e00e))
* **axir:** playbook reflector/curator need field descriptions to learn live ([5173dfa](https://github.com/ax-llm/ax/commit/5173dfa1434f854ba097716c95c1691391b7cd27))
* **axir:** port agent recovery fixes to generated packages ([05a9a26](https://github.com/ax-llm/ax/commit/05a9a2653f6b08ad304d06ce00e90f8a5f782a2b))
* **axir:** regenerate ports for the ACE curator no-op filter ([7c299d6](https://github.com/ax-llm/ax/commit/7c299d6f63fe3dafcdc6c9dac012c3355170f390))
* **axir:** Rust + Go agent-API parity (AxGen-backed) + G9 public-API parity gate ([42ad3e2](https://github.com/ax-llm/ax/commit/42ad3e2a75c719c919238368fb9b11f7d75238e2))
* **bedrock:** read Titan embedding dimensions from config (axir-no-impact) ([#550](https://github.com/ax-llm/ax/issues/550)) ([2c37bc1](https://github.com/ax-llm/ax/commit/2c37bc1a46552fce1cad40017c579b926d5edc85))
* **dsp:** AxACE must not let undefined option values clobber defaults ([f37b44a](https://github.com/ax-llm/ax/commit/f37b44a75322be3dd53b2def7fc31f7a497006eb))
* **dsp:** drop no-op acknowledgment bullets from the ACE curator ([be3382c](https://github.com/ax-llm/ax/commit/be3382c57b308f7ee84f873e16bf6b6709219b0d))
* **gepa:** prefer an accepted evolution over the seed it ties ([#546](https://github.com/ax-llm/ax/issues/546)) ([f260976](https://github.com/ax-llm/ax/commit/f260976a83d2e1dccb7f5e4a13caac3fa243d934))

## [22.0.7](https://github.com/ax-llm/ax/compare/22.0.6...22.0.7) (2026-06-24)

### Features

* **axir:** productized realtime_chat WebSocket driver for the C++ port ([a11f9c7](https://github.com/ax-llm/ax/commit/a11f9c7fcbdd2399bc2af89e06c73b7c7facb0e5))
* **axir:** productized realtime_chat WebSocket driver for the Go port ([72b881c](https://github.com/ax-llm/ax/commit/72b881cd6cff1a5c6aca1c9b27ec5203a366561d))
* **axir:** productized realtime_chat WebSocket driver for the Java port ([27e23f5](https://github.com/ax-llm/ax/commit/27e23f517dbd8e63589ba07f714debffcc686b35))
* **axir:** productized realtime_chat WebSocket driver for the Python port ([faabf69](https://github.com/ax-llm/ax/commit/faabf69ebaa1f35e4cf7f3441fe504e773fa603e))
* **axir:** productized realtime_chat WebSocket driver for the Rust port ([81af022](https://github.com/ax-llm/ax/commit/81af0227fe17f303e034527399aa71cdc8718f6d))
* **axir:** support audio content parts in OpenAI-compatible chat() across ports ([9119cef](https://github.com/ax-llm/ax/commit/9119cef49109ab1f02eda990e8830adea4ef8446))
* **axir:** transparently route realtime models through chat() across ports ([ba6e38a](https://github.com/ax-llm/ax/commit/ba6e38a2de77943e7b0fd1fa781da5e273164e0a))

### Bug Fixes

* **anthropic:** retry and fail over on transient errors (overload, rate limits, server errors) ([#556](https://github.com/ax-llm/ax/issues/556)) ([36c7808](https://github.com/ax-llm/ax/commit/36c7808f1ecd647539da33fd19c4484ce687c0ff))
* **axir:** align OpenAI realtime session.update with the current protocol ([cfac419](https://github.com/ax-llm/ax/commit/cfac41973da31be598c5d6c9e2ef7a30a00e16c8))
* **axir:** correct Gemini Live turn + move realtime WS-URL into Core ([1fa204e](https://github.com/ax-llm/ax/commit/1fa204ed26828c6981315b8e52583f33fdb56880))
* **axir:** fail codegen loud when a generated Python module lacks a helper def ([7566c74](https://github.com/ax-llm/ax/commit/7566c7470f26b2441440c2cc3ccb6e7400f75d41))
* **axir:** honor base_url for Rust audio transcribe()/speak() ([ba4ea67](https://github.com/ax-llm/ax/commit/ba4ea675d577a4ad7849b2b051a921579e7091b5))
* **axir:** make MCP Streamable HTTP transport SSE-aware in all 5 ports ([ed37627](https://github.com/ax-llm/ax/commit/ed3762769cf617193545d53d64fcabfb6b13075e))

## [22.0.7](https://github.com/ax-llm/ax/compare/22.0.5...22.0.6) (2026-06-24)

### Features

* **axir:** productized realtime_chat WebSocket driver for the C++ port ([a11f9c7](https://github.com/ax-llm/ax/commit/a11f9c7fcbdd2399bc2af89e06c73b7c7facb0e5))
* **axir:** productized realtime_chat WebSocket driver for the Go port ([72b881c](https://github.com/ax-llm/ax/commit/72b881cd6cff1a5c6aca1c9b27ec5203a366561d))
* **axir:** productized realtime_chat WebSocket driver for the Java port ([27e23f5](https://github.com/ax-llm/ax/commit/27e23f517dbd8e63589ba07f714debffcc686b35))
* **axir:** productized realtime_chat WebSocket driver for the Python port ([faabf69](https://github.com/ax-llm/ax/commit/faabf69ebaa1f35e4cf7f3441fe504e773fa603e))
* **axir:** productized realtime_chat WebSocket driver for the Rust port ([81af022](https://github.com/ax-llm/ax/commit/81af0227fe17f303e034527399aa71cdc8718f6d))
* **axir:** support audio content parts in OpenAI-compatible chat() across ports ([9119cef](https://github.com/ax-llm/ax/commit/9119cef49109ab1f02eda990e8830adea4ef8446))
* **axir:** transparently route realtime models through chat() across ports ([ba6e38a](https://github.com/ax-llm/ax/commit/ba6e38a2de77943e7b0fd1fa781da5e273164e0a))

### Bug Fixes

* **anthropic:** retry and fail over on transient errors (overload, rate limits, server errors) ([#556](https://github.com/ax-llm/ax/issues/556)) ([36c7808](https://github.com/ax-llm/ax/commit/36c7808f1ecd647539da33fd19c4484ce687c0ff))
* **axir:** align OpenAI realtime session.update with the current protocol ([cfac419](https://github.com/ax-llm/ax/commit/cfac41973da31be598c5d6c9e2ef7a30a00e16c8))
* **axir:** correct Gemini Live turn + move realtime WS-URL into Core ([1fa204e](https://github.com/ax-llm/ax/commit/1fa204ed26828c6981315b8e52583f33fdb56880))
* **axir:** fail codegen loud when a generated Python module lacks a helper def ([7566c74](https://github.com/ax-llm/ax/commit/7566c7470f26b2441440c2cc3ccb6e7400f75d41))
* **axir:** honor base_url for Rust audio transcribe()/speak() ([ba4ea67](https://github.com/ax-llm/ax/commit/ba4ea675d577a4ad7849b2b051a921579e7091b5))
* **axir:** make MCP Streamable HTTP transport SSE-aware in all 5 ports ([ed37627](https://github.com/ax-llm/ax/commit/ed3762769cf617193545d53d64fcabfb6b13075e))

## [22.0.6](https://github.com/ax-llm/ax/compare/22.0.5...22.0.6) (2026-06-21)

### Bug Fixes

* **axir:** handle binary speak()/TTS responses across the non-TS ports ([5068c65](https://github.com/ax-llm/ax/commit/5068c65efda7558590fc42f188c3fa63648f44d2))
* **axir:** implement multipart/form-data in the non-TS port HTTP layers ([57009ce](https://github.com/ax-llm/ax/commit/57009ceeeabfa4a2e9bc83e955c4cf85042d45d6))
* **axir:** populate freeform json[] output fields in the language ports ([bd3a4eb](https://github.com/ax-llm/ax/commit/bd3a4ebacb3e5471cddabe013b72460882905a3d))
* **axir:** recurse into nested object/object[] flexible-json output leaves ([aa1e64a](https://github.com/ax-llm/ax/commit/aa1e64a51f1d0cc89969971a3cc41bffb3982c32))

## [22.0.6](https://github.com/ax-llm/ax/compare/22.0.4...22.0.5) (2026-06-21)

### Bug Fixes

* **axir:** handle binary speak()/TTS responses across the non-TS ports ([5068c65](https://github.com/ax-llm/ax/commit/5068c65efda7558590fc42f188c3fa63648f44d2))
* **axir:** implement multipart/form-data in the non-TS port HTTP layers ([57009ce](https://github.com/ax-llm/ax/commit/57009ceeeabfa4a2e9bc83e955c4cf85042d45d6))
* **axir:** populate freeform json[] output fields in the language ports ([bd3a4eb](https://github.com/ax-llm/ax/commit/bd3a4ebacb3e5471cddabe013b72460882905a3d))
* **axir:** recurse into nested object/object[] flexible-json output leaves ([aa1e64a](https://github.com/ax-llm/ax/commit/aa1e64a51f1d0cc89969971a3cc41bffb3982c32))

## [22.0.5](https://github.com/ax-llm/ax/compare/22.0.4...22.0.5) (2026-06-20)

### Bug Fixes

* **maven:** bump central-publishing-maven-plugin 0.7.0 -> 0.11.0 ([#554](https://github.com/ax-llm/ax/issues/554)) ([2e0b667](https://github.com/ax-llm/ax/commit/2e0b667832554d3f299244d421c41ccfd1f945f8))

## [22.0.5](https://github.com/ax-llm/ax/compare/22.0.3...22.0.4) (2026-06-20)

### Bug Fixes

* **maven:** bump central-publishing-maven-plugin 0.7.0 -> 0.11.0 ([#554](https://github.com/ax-llm/ax/issues/554)) ([2e0b667](https://github.com/ax-llm/ax/commit/2e0b667832554d3f299244d421c41ccfd1f945f8))

## [22.0.4](https://github.com/ax-llm/ax/compare/22.0.3...22.0.4) (2026-06-20)

## [22.0.4](https://github.com/ax-llm/ax/compare/22.0.2...22.0.3) (2026-06-20)

## [22.0.3](https://github.com/ax-llm/ax/compare/22.0.2...22.0.3) (2026-06-08)

## [22.0.3](https://github.com/ax-llm/ax/compare/22.0.1...22.0.2) (2026-06-08)

## [22.0.2](https://github.com/ax-llm/ax/compare/22.0.1...22.0.2) (2026-06-05)

## [22.0.2](https://github.com/ax-llm/ax/compare/22.0.0...22.0.1) (2026-06-05)

## [22.0.1](https://github.com/ax-llm/ax/compare/22.0.0...22.0.1) (2026-06-05)

### Bug Fixes

* **openai:** correct stale per-model prices in OpenAI info table ([#525](https://github.com/ax-llm/ax/issues/525)) ([c85eceb](https://github.com/ax-llm/ax/commit/c85eceb058894e702d9b42ecec97cd994a60f03e))

## [22.0.1](https://github.com/ax-llm/ax/compare/21.0.14...22.0.0) (2026-06-05)

### Bug Fixes

* **openai:** correct stale per-model prices in OpenAI info table ([#525](https://github.com/ax-llm/ax/issues/525)) ([c85eceb](https://github.com/ax-llm/ax/commit/c85eceb058894e702d9b42ecec97cd994a60f03e))

## [22.0.0](https://github.com/ax-llm/ax/compare/21.0.14...22.0.0) (2026-06-04)

### Bug Fixes

* type fix ([a5a0cc6](https://github.com/ax-llm/ax/commit/a5a0cc65dfe36ee385bc08b658d796846cd496c4))

## [22.0.0](https://github.com/ax-llm/ax/compare/21.0.13...21.0.14) (2026-06-04)

### Bug Fixes

* type fix ([a5a0cc6](https://github.com/ax-llm/ax/commit/a5a0cc65dfe36ee385bc08b658d796846cd496c4))

## [21.0.14](https://github.com/ax-llm/ax/compare/21.0.13...21.0.14) (2026-05-25)

## [21.0.14](https://github.com/ax-llm/ax/compare/21.0.12...21.0.13) (2026-05-25)

## [21.0.13](https://github.com/ax-llm/ax/compare/21.0.12...21.0.13) (2026-05-24)

## [21.0.13](https://github.com/ax-llm/ax/compare/21.0.11...21.0.12) (2026-05-24)

## [21.0.12](https://github.com/ax-llm/ax/compare/21.0.11...21.0.12) (2026-05-22)

## [21.0.12](https://github.com/ax-llm/ax/compare/21.0.10...21.0.11) (2026-05-22)

## [21.0.11](https://github.com/ax-llm/ax/compare/21.0.10...21.0.11) (2026-05-21)

## [21.0.11](https://github.com/ax-llm/ax/compare/21.0.9...21.0.10) (2026-05-21)

## [21.0.10](https://github.com/ax-llm/ax/compare/21.0.9...21.0.10) (2026-05-21)

## [21.0.10](https://github.com/ax-llm/ax/compare/21.0.8...21.0.9) (2026-05-21)

## [21.0.9](https://github.com/ax-llm/ax/compare/21.0.8...21.0.9) (2026-05-19)

## [21.0.9](https://github.com/ax-llm/ax/compare/21.0.6...21.0.8) (2026-05-19)

## [21.0.8](https://github.com/ax-llm/ax/compare/21.0.6...21.0.8) (2026-05-17)

## [21.0.8](https://github.com/ax-llm/ax/compare/21.0.6...21.0.6) (2026-05-17)

## [21.0.7](https://github.com/ax-llm/ax/compare/21.0.6...21.0.6) (2026-05-17)

## [21.0.6](https://github.com/ax-llm/ax/compare/21.0.4...21.0.5) (2026-05-16)

### Features

* improve ax agent context management ([7b974ad](https://github.com/ax-llm/ax/commit/7b974ade805c42d70b8b94a238f8736340ad984b))

### Bug Fixes

* package fixes ([e7e260b](https://github.com/ax-llm/ax/commit/e7e260b31716e51da04d52fc33554bd12b12cea9))

## [21.0.5](https://github.com/ax-llm/ax/compare/21.0.4...21.0.5) (2026-05-15)

### Features

* **ai:** add new models, xhigh reasoning effort, and Anthropic structured output fix ([ec008b7](https://github.com/ax-llm/ax/commit/ec008b772ec12ace026a453a11f5af1e23c6a9ec))

### Bug Fixes

* **ai:** record streaming token usage as deltas, not cumulative ([#516](https://github.com/ax-llm/ax/issues/516)) ([4f7f417](https://github.com/ax-llm/ax/commit/4f7f417860d18d051f458579903701e1fe2635c4))
* **anthropic:** emit cache_control on content blocks, not envelopes ([#517](https://github.com/ax-llm/ax/issues/517)) ([c12a3a8](https://github.com/ax-llm/ax/commit/c12a3a8374bcd8c626dc312cbd3c8a18841b6d4d))

## [21.0.5](///compare/21.0.3...21.0.4) (2026-05-15)

### Features

* **ai:** add new models, xhigh reasoning effort, and Anthropic structured output fix ec008b7

### Bug Fixes

* **ai:** record streaming token usage as deltas, not cumulative ([#516](undefined/undefined/undefined/issues/516)) 4f7f417
* **anthropic:** emit cache_control on content blocks, not envelopes ([#517](undefined/undefined/undefined/issues/517)) c12a3a8
## [21.0.4](///compare/21.0.3...21.0.4) (2026-05-14)

## [21.0.4](///compare/21.0.2...21.0.3) (2026-05-14)
## [21.0.3](///compare/21.0.2...21.0.3) (2026-05-13)

## [21.0.3](///compare/21.0.1...21.0.2) (2026-05-13)
## [21.0.2](///compare/21.0.1...21.0.2) (2026-05-12)

### Bug Fixes

* **ai:** expose includeRequestBodyInErrors on AxAIServiceOptions ([#514](undefined/undefined/undefined/issues/514)) a22531c

## [21.0.2](///compare/21.0.0...21.0.1) (2026-05-12)

### Bug Fixes

* **ai:** expose includeRequestBodyInErrors on AxAIServiceOptions ([#514](undefined/undefined/undefined/issues/514)) a22531c
## [21.0.1](///compare/21.0.0...21.0.1) (2026-05-12)

## [21.0.1](///compare/20.0.2...21.0.0) (2026-05-12)
## [21.0.0](///compare/20.0.2...21.0.0) (2026-05-09)

### Features

* **agent:** pass alreadyLoaded snapshot to onMemoriesSearch 69ae7d2
* **agent:** unify child-agent registration through functions array 689c0ba

### Bug Fixes

* **skill:** drop false claim that forward() exposes memory results e8f5686

## [21.0.0](///compare/20.0.1...20.0.2) (2026-05-09)

### Features

* **agent:** pass alreadyLoaded snapshot to onMemoriesSearch 69ae7d2
* **agent:** unify child-agent registration through functions array 689c0ba

### Bug Fixes

* **skill:** drop false claim that forward() exposes memory results e8f5686
## [20.0.2](///compare/20.0.1...20.0.2) (2026-05-08)

### Bug Fixes

* **examples:** remove deleted recursionOptions.maxDepth, fix functions shape a1b65c8
* **google-gemini:** correct Vertex cachedContents URL and model resource ([#513](undefined/undefined/undefined/issues/513)) f2c39e5

## [20.0.2](///compare/20.0.0...20.0.1) (2026-05-08)

### Bug Fixes

* **examples:** remove deleted recursionOptions.maxDepth, fix functions shape a1b65c8
* **google-gemini:** correct Vertex cachedContents URL and model resource ([#513](undefined/undefined/undefined/issues/513)) f2c39e5
## [20.0.1](///compare/20.0.0...20.0.1) (2026-04-30)

### Bug Fixes

* **docs:** remove deleted llmQueryPromptMode field; add typecheck to CI 947fcdf
* **sig:** avoid structuredClone on Zod-backed fields, expose AxSignatureConfig overloads ([#512](undefined/undefined/undefined/issues/512)) 0222938

## [20.0.1](///compare/19.0.45...20.0.0) (2026-04-30)

### Bug Fixes

* **docs:** remove deleted llmQueryPromptMode field; add typecheck to CI 947fcdf
* **sig:** avoid structuredClone on Zod-backed fields, expose AxSignatureConfig overloads ([#512](undefined/undefined/undefined/issues/512)) 0222938
## [20.0.0](///compare/19.0.45...20.0.0) (2026-04-25)

### Features

* **agent:** add contextOptions to independently bound the ctx distillation stage 7e77158
* **agent:** drop llmQuery advanced mode, simplify RLM actor prompts 1f2d8a1
* **agent:** Stage 2+3 — split RLM actor templates and coordinator AxAgent 68cdff3

### Bug Fixes

* **gemini:** default Vertex Gemini to v1 and harden streaming ([#511](undefined/undefined/undefined/issues/511)) 8ee4c3e

### Performance Improvements

* **agent:** shrink RLM actor system prompt by ~480 chars ce46475

## [20.0.0](///compare/19.0.44...19.0.45) (2026-04-25)

### Features

* **agent:** add contextOptions to independently bound the ctx distillation stage 7e77158
* **agent:** drop llmQuery advanced mode, simplify RLM actor prompts 1f2d8a1
* **agent:** Stage 2+3 — split RLM actor templates and coordinator AxAgent 68cdff3

### Bug Fixes

* **gemini:** default Vertex Gemini to v1 and harden streaming ([#511](undefined/undefined/undefined/issues/511)) 8ee4c3e

### Performance Improvements

* **agent:** shrink RLM actor system prompt by ~480 chars ce46475
## [19.0.45](///compare/19.0.44...19.0.45) (2026-04-15)

### Features

* node thread worker security upgrades 4a29618
* support for zod / standard-schema/spec 82583ee

## [19.0.45](///compare/19.0.43...19.0.44) (2026-04-15)

### Features

* node thread worker security upgrades 4a29618
* support for zod / standard-schema/spec 82583ee

### Bug Fixes

* **metrics:** use shared model name normalization for cost and config lookups ([#509](undefined/undefined/undefined/issues/509)) 5e885af

## [19.0.44](///compare/19.0.43...19.0.44) (2026-04-13)

### Bug Fixes

* **metrics:** use shared model name normalization for cost and config lookups ([#509](undefined/undefined/undefined/issues/509)) 5e885af4

## [19.0.43](///compare/19.0.42...19.0.43) (2026-04-10)

### Bug Fixes

* **metrics:** accurate estimated cost metric for all request types ([#508](undefined/undefined/undefined/issues/508)) 07f2ba75
* **agent:** extract code from anywhere in javascriptCode field ([#507](undefined/undefined/undefined/issues/507)) 2894bcd0
* fix ollama thinking ([#506](undefined/undefined/undefined/issues/506)) b1fcdf32

## [19.0.42](///compare/19.0.40...19.0.41) (2026-04-07)

### Features

* add GPT-5.4 models + fix: pass chatReqUpdater through Azure OpenAI ([#505](undefined/undefined/undefined/issues/505)) 6cef135

### Bug Fixes

* various fixes d12a683
* various fixes 5d257d5
## [19.0.41](///compare/19.0.40...19.0.41) (2026-04-01)

## [19.0.41](///compare/19.0.39...19.0.40) (2026-04-01)
## [19.0.40](///compare/19.0.39...19.0.40) (2026-04-01)

## [19.0.40](///compare/19.0.38...19.0.39) (2026-04-01)
## [19.0.39](///compare/19.0.38...19.0.39) (2026-04-01)

### Bug Fixes

* gemini 3.1 pro vertex fixes 979383d

## [19.0.39](///compare/19.0.37...19.0.38) (2026-04-01)

### Bug Fixes

* gemini 3.1 pro vertex fixes 979383d
## [19.0.38](///compare/19.0.37...19.0.38) (2026-03-29)

### Features

* chat logs for training data 874e38f

## [19.0.38](///compare/19.0.36...19.0.37) (2026-03-29)

### Features

* chat logs for training data 874e38f
## [19.0.37](///compare/19.0.36...19.0.37) (2026-03-27)

### Features

* **dsp:** add customTemplate option to AxGen ([#499](undefined/undefined/undefined/issues/499)) 63e496e, closes #469 #493
* refresh system prompt <available_functions> after ctx.addFunctions() ([#501](undefined/undefined/undefined/issues/501)) 6d8517c, closes #500

### Bug Fixes

* preserve thought_signature in Gemini 3 context cache paths ([#502](undefined/undefined/undefined/issues/502)) 31e2f95
* various fixes f50828c

## [19.0.37](///compare/19.0.35...19.0.36) (2026-03-27)

### Features

* **dsp:** add customTemplate option to AxGen ([#499](undefined/undefined/undefined/issues/499)) 63e496e, closes #469 #493
* refresh system prompt <available_functions> after ctx.addFunctions() ([#501](undefined/undefined/undefined/issues/501)) 6d8517c, closes #500

### Bug Fixes

* preserve thought_signature in Gemini 3 context cache paths ([#502](undefined/undefined/undefined/issues/502)) 31e2f95
* various fixes f50828c
## [19.0.36](///compare/19.0.35...19.0.36) (2026-03-27)

### Bug Fixes

* various fixes 05cbc64

## [19.0.36](///compare/19.0.34...19.0.35) (2026-03-27)

### Bug Fixes

* various fixes 05cbc64
## [19.0.35](///compare/19.0.34...19.0.35) (2026-03-26)

### Bug Fixes

* handle read-only global properties in Deno worker scope f2ae6a8

## [19.0.35](///compare/19.0.33...19.0.34) (2026-03-26)

### Bug Fixes

* handle read-only global properties in Deno worker scope f2ae6a8
## [19.0.34](///compare/19.0.33...19.0.34) (2026-03-26)

### Features

* add agentStatusCallback and fix final() contract in AxAgent RLM 921357f
* add stop() and success()/failed() to AxAgentCompletionProtocol 375e391

## [19.0.34](///compare/19.0.32...19.0.33) (2026-03-26)

### Features

* add agentStatusCallback and fix final() contract in AxAgent RLM 921357f
* add stop() and success()/failed() to AxAgentCompletionProtocol 375e391
## [19.0.33](///compare/19.0.32...19.0.33) (2026-03-24)

### Bug Fixes

* handle DataCloneError in JS runtime worker message passing 8f54922

## [19.0.33](///compare/19.0.31...19.0.32) (2026-03-24)

### Bug Fixes

* handle DataCloneError in JS runtime worker message passing 8f54922
## [19.0.32](///compare/19.0.31...19.0.32) (2026-03-24)

### Features

* improvements to the live runtime state system 0ed618d

### Bug Fixes

* various rlm runtime fixes 929939e

## [19.0.32](///compare/19.0.30...19.0.31) (2026-03-24)

### Features

* improvements to the live runtime state system 0ed618d

### Bug Fixes

* various rlm runtime fixes 929939e
## [19.0.31](///compare/19.0.30...19.0.31) (2026-03-23)

### Bug Fixes

* Bubble up AxAgentClarificationError instead of logging in actorLog 7eb3739
* test failures c8e5cae

## [19.0.31](///compare/19.0.29...19.0.30) (2026-03-23)

### Bug Fixes

* Bubble up AxAgentClarificationError instead of logging in actorLog 7eb3739
* test failures c8e5cae
## [19.0.30](///compare/19.0.29...19.0.30) (2026-03-23)

## [19.0.30](///compare/19.0.28...19.0.29) (2026-03-23)
## [19.0.29](///compare/19.0.28...19.0.29) (2026-03-22)

## [19.0.29](///compare/19.0.27...19.0.28) (2026-03-22)
## [19.0.28](///compare/19.0.27...19.0.28) (2026-03-22)

## [19.0.28](///compare/19.0.26...19.0.27) (2026-03-22)
## [19.0.27](///compare/19.0.26...19.0.27) (2026-03-22)

## [19.0.27](///compare/19.0.25...19.0.26) (2026-03-22)
## [19.0.26](///compare/19.0.25...19.0.26) (2026-03-21)

## [19.0.26](///compare/19.0.24...19.0.25) (2026-03-21)
## [19.0.25](///compare/19.0.24...19.0.25) (2026-03-20)

## [19.0.25](///compare/19.0.23...19.0.24) (2026-03-20)
## [19.0.24](///compare/19.0.23...19.0.24) (2026-03-19)

### Bug Fixes

* agent refactor and other fixes 2018ddc

## [19.0.24](///compare/19.0.22...19.0.23) (2026-03-19)

### Bug Fixes

* agent refactor and other fixes 2018ddc
## [19.0.23](///compare/19.0.22...19.0.23) (2026-03-19)

### Features

* automatic model upgrade in axagent d841ed6

## [19.0.23](///compare/19.0.21...19.0.22) (2026-03-19)

### Features

* automatic model upgrade in axagent d841ed6
## [19.0.22](///compare/19.0.21...19.0.22) (2026-03-18)

### Features

* gepa optimizer for axagent and other features 12e0644

## [19.0.22](///compare/19.0.20...19.0.21) (2026-03-18)

### Features

* gepa optimizer for axagent and other features 12e0644
## [19.0.21](///compare/19.0.20...19.0.21) (2026-03-18)

### Features

* redesign of axagent advanced mode (true recursion) e8c075e

## [19.0.21](///compare/19.0.19...19.0.20) (2026-03-18)

### Features

* redesign of axagent advanced mode (true recursion) e8c075e
## [19.0.20](///compare/19.0.19...19.0.20) (2026-03-17)

### Features

* better agent prompt, more contex policy presets and new callbacks 7a36501

## [19.0.20](///compare/19.0.18...19.0.19) (2026-03-17)

### Features

* better agent prompt, more contex policy presets and new callbacks 7a36501
## [19.0.19](///compare/19.0.18...19.0.19) (2026-03-17)

### Bug Fixes

* deno webworker fixes b4f9538

## [19.0.19](///compare/19.0.17...19.0.18) (2026-03-17)

### Bug Fixes

* deno webworker fixes b4f9538
## [19.0.18](///compare/19.0.17...19.0.18) (2026-03-17)

### Features

* state management and gepa optimization for axagent 48fb04b

## [19.0.18](///compare/19.0.16...19.0.17) (2026-03-17)

### Features

* state management and gepa optimization for axagent 48fb04b
## [19.0.17](///compare/19.0.16...19.0.17) (2026-03-15)

### Features

* major docs cleanup and nw website cc9adca
* massive improvements to axagent context policy 4b9772f

## [19.0.17](///compare/19.0.15...19.0.16) (2026-03-15)

### Features

* major docs cleanup and nw website cc9adca
* massive improvements to axagent context policy 4b9772f
## [19.0.16](///compare/19.0.15...19.0.16) (2026-03-11)

### Features

* axagent test harness 413b590

### Bug Fixes

* build fix 617a48b

## [19.0.16](///compare/19.0.14...19.0.15) (2026-03-11)

### Features

* axagent test harness 413b590

### Bug Fixes

* build fix 617a48b
## [19.0.15](///compare/19.0.14...19.0.15) (2026-03-09)

## [19.0.15](///compare/19.0.13...19.0.14) (2026-03-09)
## [19.0.14](///compare/19.0.13...19.0.14) (2026-03-09)

### Bug Fixes

* make llm use batch functions a5d694e
* optimize discovery prompts for axagent 8304a63

## [19.0.14](///compare/19.0.12...19.0.13) (2026-03-09)

### Bug Fixes

* make llm use batch functions a5d694e
* optimize discovery prompts for axagent 8304a63
## [19.0.13](///compare/19.0.12...19.0.13) (2026-03-07)

### Features

* implement patchGlobals method for AxCodeSession and update related functionality ef03ceb

## [19.0.13](///compare/19.0.11...19.0.12) (2026-03-07)

### Features

* implement patchGlobals method for AxCodeSession and update related functionality ef03ceb
## [19.0.12](///compare/19.0.11...19.0.12) (2026-03-06)

### Features

* add inputUpdateCallback for dynamic input updates during actor turns b233e2f
* add RLM Discovery example with writing coach and analytics tools 9f5ec0d

### Bug Fixes

* update model names and costs for Google Gemini configurations 48b3235

## [19.0.12](///compare/19.0.10...19.0.11) (2026-03-06)

### Features

* add inputUpdateCallback for dynamic input updates during actor turns b233e2f
* add RLM Discovery example with writing coach and analytics tools 9f5ec0d

### Bug Fixes

* update model names and costs for Google Gemini configurations 48b3235
## [19.0.11](///compare/19.0.10...19.0.11) (2026-03-01)

### Features

* add local field support to keep shared fields available in parent agents e84014b

### Bug Fixes

* don't throw on bare object schemas in Anthropic tool parameters ([#494](undefined/undefined/undefined/issues/494)) c7a4ecc
* update schema validation to allow arbitrary JSON objects in structured outputs 77c4583

## [19.0.11](///compare/19.0.9...19.0.10) (2026-03-01)

### Features

* add local field support to keep shared fields available in parent agents e84014b

### Bug Fixes

* don't throw on bare object schemas in Anthropic tool parameters ([#494](undefined/undefined/undefined/issues/494)) c7a4ecc
* update schema validation to allow arbitrary JSON objects in structured outputs 77c4583
## [19.0.10](///compare/19.0.9...19.0.10) (2026-02-27)

### Features

* implement session auto-recovery after timeout and improve error handling 7f76d94

## [19.0.10](///compare/19.0.8...19.0.9) (2026-02-27)

### Features

* implement session auto-recovery after timeout and improve error handling 7f76d94
## [19.0.9](///compare/19.0.8...19.0.9) (2026-02-27)

### Features

* enhance error handling by providing focused source context for runtime errors 7b3e5ee

## [19.0.9](///compare/19.0.7...19.0.8) (2026-02-27)

### Features

* enhance error handling by providing focused source context for runtime errors 7b3e5ee
## [19.0.8](///compare/19.0.7...19.0.8) (2026-02-26)

### Features

* enhance error formatting and template rendering 1dc59ae

## [19.0.8](///compare/19.0.6...19.0.7) (2026-02-26)

### Features

* enhance error formatting and template rendering 1dc59ae

## [19.0.7](///compare/19.0.5...19.0.6) (2026-02-26)
## [19.0.6](///compare/19.0.5...19.0.6) (2026-02-26)

### Bug Fixes

* build fix 7286042

## [19.0.6](///compare/19.0.4...19.0.5) (2026-02-26)

### Bug Fixes

* build fix 7286042
## [19.0.5](///compare/19.0.4...19.0.5) (2026-02-26)

### Features

* enhance context field handling and improve type normalization in RLM bdd2ccd

## [19.0.5](///compare/19.0.3...19.0.4) (2026-02-26)

### Features

* enhance context field handling and improve type normalization in RLM bdd2ccd
## [19.0.4](///compare/19.0.3...19.0.4) (2026-02-26)

## [19.0.4](///compare/19.0.2...19.0.3) (2026-02-26)
## [19.0.3](///compare/19.0.2...19.0.3) (2026-02-26)

## [19.0.3](///compare/19.0.1...19.0.2) (2026-02-26)
## [19.0.2](///compare/19.0.1...19.0.2) (2026-02-25)

### Features

* add self-registration prevention for child agents and update documentation references 74f9c14

## [19.0.2](///compare/19.0.0...19.0.1) (2026-02-25)

### Features

* add self-registration prevention for child agents and update documentation references 74f9c14
## [19.0.1](///compare/19.0.0...19.0.1) (2026-02-25)

### Features

* update agent function structure to use object notation for functions and agents 399e454

## [19.0.1](///compare/18.0.14...19.0.0) (2026-02-25)

### Features

* update agent function structure to use object notation for functions and agents 399e454
## [19.0.0](///compare/18.0.14...19.0.0) (2026-02-25)

## [19.0.0](///compare/18.0.13...18.0.14) (2026-02-25)

### Features

* enhance AxAgent with agent function management and sharing capabilities 9ab332b

## [18.0.14](///compare/18.0.12...18.0.13) (2026-02-25)

### Features

* enhance AxAgent with agent function management and sharing capabilities 9ab332b
## [18.0.13](///compare/18.0.12...18.0.13) (2026-02-24)

### Features

* Add support for shared fields and agents in AxAgent, enhancing agent hierarchy data passing e541397

## [18.0.13](///compare/18.0.11...18.0.12) (2026-02-24)

### Features

* Add ai parameter to wrapFunction and related methods in AxAgent for enhanced functionality 0e59c96
* Add support for shared fields and agents in AxAgent, enhancing agent hierarchy data passing e541397

## [18.0.12](///compare/18.0.10...18.0.11) (2026-02-24)

### Features

* Add ai parameter to wrapFunction and related methods in AxAgent for enhanced functionality 0e59c96
## [18.0.11](///compare/18.0.10...18.0.11) (2026-02-24)

### Features

* Enhance shared fields handling in AxAgent and add new tests for parameter scoping f8002bc

## [18.0.11](///compare/18.0.9...18.0.10) (2026-02-24)

### Features

* Enhance shared fields handling in AxAgent and add new tests for parameter scoping f8002bc
## [18.0.10](///compare/18.0.9...18.0.10) (2026-02-24)

### Features

* Add toInputJSONSchema method and related tests for AxSignature and agent function parameters c836239

## [18.0.10](///compare/18.0.8...18.0.9) (2026-02-24)

### Features

* Add toInputJSONSchema method and related tests for AxSignature and agent function parameters c836239
## [18.0.9](///compare/18.0.8...18.0.9) (2026-02-24)

### Features

* Add support for shared fields in AxAgent and context management 59d7604
* Enhance context management with updated tombstoning options and new example 09a9c25
* Implement semantic context management in AxAgent 899540b

## [18.0.9](///compare/18.0.7...18.0.8) (2026-02-24)

### Features

* Add support for shared fields in AxAgent and context management 59d7604
* Enhance context management with updated tombstoning options and new example 09a9c25
* Implement semantic context management in AxAgent 899540b
* **runtime:** add consecutive execution error cutoff and enhance error handling in AxJSRuntime f8c06fa

## [18.0.8](///compare/18.0.6...18.0.7) (2026-02-23)

### Features

* **runtime:** add consecutive execution error cutoff and enhance error handling in AxJSRuntime f8c06fa
## [18.0.7](///compare/18.0.6...18.0.7) (2026-02-22)

### Features

* **worker:** add tests for variable persistence across async calls and enhance axWorkerRuntime with top-level declaration extraction a2ba6b3

## [18.0.7](///compare/18.0.5...18.0.6) (2026-02-22)

### Features

* **worker:** add tests for variable persistence across async calls and enhance axWorkerRuntime with top-level declaration extraction a2ba6b3
## [18.0.6](///compare/18.0.5...18.0.6) (2026-02-21)

### Features

* **worker:** enhance axWorkerRuntime and getWorkerSource with improved serialization handling and bundler polyfills 51a9994

### Bug Fixes

* **worker:** use bundler-safe require access in serialized runtime 4c0e127

## [18.0.6](///compare/18.0.4...18.0.5) (2026-02-21)

### Features

* **worker:** enhance axWorkerRuntime and getWorkerSource with improved serialization handling and bundler polyfills 51a9994
* **worker:** implement axWorkerRuntime for improved worker source management 9e99e48

### Bug Fixes

* **worker:** use bundler-safe require access in serialized runtime 4c0e127

## [18.0.5](///compare/18.0.3...18.0.4) (2026-02-21)

### Features

* **worker:** implement axWorkerRuntime for improved worker source management 9e99e48
## [18.0.4](///compare/18.0.3...18.0.4) (2026-02-20)

### Features

* Implement getUsageInstructions method in AxCodeRuntime and update related usages across multiple files for consistency 7f2dfcd

### Bug Fixes

* Migrate from nested `rlm` object to top-level properties for context fields, runtime, and other options across multiple agents and examples. Update documentation and examples to reflect the new structure, ensuring clarity in agent definitions and improving consistency in code organization. 3c55e1c

## [18.0.4](///compare/18.0.2...18.0.3) (2026-02-20)

### Features

* Enhance AxAgent with recursion options and action description logging 908303d
* Implement getUsageInstructions method in AxCodeRuntime and update related usages across multiple files for consistency 7f2dfcd

### Bug Fixes

* Migrate from nested `rlm` object to top-level properties for context fields, runtime, and other options across multiple agents and examples. Update documentation and examples to reflect the new structure, ensuring clarity in agent definitions and improving consistency in code organization. 3c55e1c

## [18.0.3](///compare/18.0.1...18.0.2) (2026-02-20)

### Features

* Enhance AxAgent with recursion options and action description logging 908303d
## [18.0.2](///compare/18.0.1...18.0.2) (2026-02-19)

### Features

* Enhance AxAgent with demo validation and descriptions 462bc72

## [18.0.2](///compare/18.0.0...18.0.1) (2026-02-19)

### Features

* Enhance AxAgent with demo validation and descriptions 462bc72

## [18.0.1](///compare/17.0.11...18.0.0) (2026-02-19)
## [18.0.0](///compare/17.0.11...18.0.0) (2026-02-19)

### Features

* Redesign of AxAgent to be RLM native ddb1f17

## [18.0.0](///compare/17.0.10...17.0.11) (2026-02-19)

### Features

* Redesign of AxAgent to be RLM native ddb1f17
## [17.0.11](///compare/17.0.10...17.0.11) (2026-02-17)

### Bug Fixes

* update AxJSRuntime usage instructions and enhance llmQuery handling in AxAgent c424489

## [17.0.11](///compare/17.0.9...17.0.10) (2026-02-17)

### Bug Fixes

* update AxJSRuntime usage instructions and enhance llmQuery handling in AxAgent c424489
## [17.0.10](///compare/17.0.9...17.0.10) (2026-02-17)

### Features

* enhance AxJSRuntime with output mode and usage instructions fe07dec

## [17.0.10](///compare/17.0.8...17.0.9) (2026-02-17)

### Features

* enhance AxJSRuntime with output mode and usage instructions fe07dec
## [17.0.9](///compare/17.0.8...17.0.9) (2026-02-17)

### Features

* new inline and function modse for axagent rlm a2b4c0f

## [17.0.9](///compare/17.0.7...17.0.8) (2026-02-17)

### Features

* new inline and function modse for axagent rlm a2b4c0f
## [17.0.8](///compare/17.0.7...17.0.8) (2026-02-16)

### Features

* improve error handling in AxJSRuntime and integration tests 799a425

## [17.0.8](///compare/17.0.6...17.0.7) (2026-02-16)

### Features

* improve error handling in AxJSRuntime and integration tests 799a425
## [17.0.7](///compare/17.0.6...17.0.7) (2026-02-16)

### Features

* enhance error handling with data preservation in AxJSRuntime 272a8ee

## [17.0.7](///compare/17.0.5...17.0.6) (2026-02-16)

### Features

* enhance error handling with data preservation in AxJSRuntime 272a8ee
## [17.0.6](///compare/17.0.5...17.0.6) (2026-02-16)

### Features

* enhance error handling in AxJSRuntime ed939cf

## [17.0.6](///compare/17.0.4...17.0.5) (2026-02-16)

### Features

* enhance error handling in AxJSRuntime ed939cf
## [17.0.5](///compare/17.0.4...17.0.5) (2026-02-16)

### Features

* enhance RLM session management and error handling 77493d5

## [17.0.5](///compare/17.0.3...17.0.4) (2026-02-16)

### Features

* enhance RLM session management and error handling 77493d5
## [17.0.4](///compare/17.0.3...17.0.4) (2026-02-16)

### Features

* implement RLM session recreation and error handling 2158092

## [17.0.4](///compare/17.0.2...17.0.3) (2026-02-16)

### Features

* implement RLM session recreation and error handling 2158092
## [17.0.3](///compare/17.0.2...17.0.3) (2026-02-16)

## [17.0.3](///compare/17.0.1...17.0.2) (2026-02-16)
## [17.0.2](///compare/17.0.1...17.0.2) (2026-02-15)

### Features

* rename AxCodeInterpreter to AxCodeRuntime d9b5e9a

## [17.0.2](///compare/17.0.0...17.0.1) (2026-02-15)

### Features

* rename AxCodeInterpreter to AxCodeRuntime d9b5e9a
## [17.0.1](///compare/17.0.0...17.0.1) (2026-02-15)

### Bug Fixes

* make RLM interpreter returns less brittle 6d0b314

## [17.0.1](///compare/16.1.12...17.0.0) (2026-02-15)

### Bug Fixes

* make RLM interpreter returns less brittle 6d0b314
## [17.0.0](///compare/16.1.12...17.0.0) (2026-02-15)

### ⚠ BREAKING CHANGES

* rename AxJSInterpreter API to AxJSRuntime

### Features

* harden stop/abort behavior across AxGen, AxAgent, and AxFlow a5c7f9b
* rename AxJSInterpreter API to AxJSRuntime c0a6f13
* unify JavaScript runtime interpreter across packages 9b0c0f7

## [17.0.0](///compare/16.1.11...16.1.12) (2026-02-15)

### ⚠ BREAKING CHANGES

* rename AxJSInterpreter API to AxJSRuntime

### Features

* harden stop/abort behavior across AxGen, AxAgent, and AxFlow a5c7f9b
* rename AxJSInterpreter API to AxJSRuntime c0a6f13
* unify JavaScript runtime interpreter across packages 9b0c0f7
## [16.1.12](///compare/16.1.11...16.1.12) (2026-02-14)

### Features

* add RLM support in AxAgent for long context analysis 41e3254

## [16.1.12](///compare/16.1.10...16.1.11) (2026-02-14)

### Features

* add RLM support in AxAgent for long context analysis 41e3254
## [16.1.11](///compare/16.1.10...16.1.11) (2026-02-14)

### Features

* introduce AxRLMJSInterpreter with sandbox permissions and update documentation 2f0e990

## [16.1.11](///compare/16.1.9...16.1.10) (2026-02-14)

### Features

* introduce AxRLMJSInterpreter with sandbox permissions and update documentation 2f0e990
## [16.1.10](///compare/16.1.9...16.1.10) (2026-02-12)

### Features

* enhance postbuild and postinstall scripts for skill file handling 28d260b

## [16.1.10](///compare/16.1.8...16.1.9) (2026-02-12)

### Features

* enhance postbuild and postinstall scripts for skill file handling 28d260b
## [16.1.9](///compare/16.1.8...16.1.9) (2026-02-12)

### Features

* implement abort functionality in AxAgent, AxGen, and AxFlow d450bbd

### Bug Fixes

* unify llmQuery functionality and update documentation af64cf9

## [16.1.9](///compare/16.1.7...16.1.8) (2026-02-12)

### Features

* implement abort functionality in AxAgent, AxGen, and AxFlow d450bbd

### Bug Fixes

* unify llmQuery functionality and update documentation af64cf9
## [16.1.8](///compare/16.1.7...16.1.8) (2026-02-11)

### Features

* enhance AxAgent with structured context fields and improve documentation b149463

## [16.1.8](///compare/16.1.6...16.1.7) (2026-02-11)

### Features

* enhance AxAgent with structured context fields and improve documentation b149463
## [16.1.7](///compare/16.1.6...16.1.7) (2026-02-10)

### Features

* enhance AxAIGoogleGemini tests for thinkingBudget preservation dbe1245

## [16.1.7](///compare/16.1.5...16.1.6) (2026-02-10)

### Features

* add AxAgent RLM support, self-tuning improvements, and docs updates 508ba77
* enhance AxAIGoogleGemini tests for thinkingBudget preservation dbe1245

### Bug Fixes

* correct temperature property in self-tuning schema generation 59efdb3

## [16.1.6](///compare/16.1.4...16.1.5) (2026-02-09)

### Features

* add AxAgent RLM support, self-tuning improvements, and docs updates 508ba77

### Bug Fixes

* correct temperature property in self-tuning schema generation 59efdb3
## [16.1.5](///compare/16.1.4...16.1.5) (2026-02-08)

### Bug Fixes

* remove unused @types/uuid dev dependency breaking type-checks 876e45c

## [16.1.5](///compare/16.1.2...16.1.4) (2026-02-08)

### Bug Fixes

* remove unused @types/uuid dev dependency breaking type-checks 876e45c
## [16.1.4](///compare/16.1.2...16.1.4) (2026-02-08)

### Features

* add function-call fallback for structured output on unsupported providers f3e787c
* add step context, step hooks, and self-tuning with enriched descriptions 76bddaa

### Bug Fixes

* ensure Gemini 3+ minimum temperature of 1.0 is actually applied 57c8edd
* normalize type unions in cleanSchemaForGemini for json[] compatibility ([#488](undefined/undefined/undefined/issues/488)) fdba299

## [16.1.4](///compare/16.1.2...16.1.2) (2026-02-08)

### Features

* add function-call fallback for structured output on unsupported providers f3e787c
* add step context, step hooks, and self-tuning with enriched descriptions 76bddaa

### Bug Fixes

* ensure Gemini 3+ minimum temperature of 1.0 is actually applied 57c8edd
* normalize type unions in cleanSchemaForGemini for json[] compatibility ([#488](undefined/undefined/undefined/issues/488)) fdba299

## [16.1.3](///compare/16.1.1...16.1.2) (2026-02-08)

### Features

* add function-call fallback for structured output on unsupported providers f3e787c
* add step context, step hooks, and self-tuning with enriched descriptions 76bddaa

### Bug Fixes

* ensure Gemini 3+ minimum temperature of 1.0 is actually applied 57c8edd
## [16.1.2](///compare/16.1.1...16.1.2) (2026-02-06)

### Bug Fixes

* enforce model-specific thinking params and default temp for Gemini 3+ 00b181d

## [16.1.2](///compare/16.1.0...16.1.1) (2026-02-06)

### Bug Fixes

* enforce model-specific thinking params and default temp for Gemini 3+ 00b181d
## [16.1.1](///compare/16.1.0...16.1.1) (2026-02-04)

## [16.1.1](///compare/16.0.13...16.1.0) (2026-02-04)
## [16.1.0](///compare/16.0.13...16.1.0) (2026-02-02)

### Bug Fixes

* update dependencies and enhance Gemini model handling 1b03d62

## [16.1.0](///compare/16.0.12...16.0.13) (2026-02-02)

### Bug Fixes

* update dependencies and enhance Gemini model handling 1b03d62
## [16.0.13](///compare/16.0.12...16.0.13) (2026-01-29)

### Bug Fixes

* prevent item duplication during streaming finalization [#484](undefined/undefined/undefined/issues/484) [#484](undefined/undefined/undefined/issues/484) 262fd32

## [16.0.13](///compare/16.0.11...16.0.12) (2026-01-29)

### Bug Fixes

* prevent item duplication during streaming finalization [#484](undefined/undefined/undefined/issues/484) [#484](undefined/undefined/undefined/issues/484) 262fd32
## [16.0.12](///compare/16.0.11...16.0.12) (2026-01-27)

### Features

* enhance README and CLI functionality [#482](undefined/undefined/undefined/issues/482) [#475](undefined/undefined/undefined/issues/475) 67bf283

## [16.0.12](///compare/16.0.10...16.0.11) (2026-01-27)

### Features

* enhance README and CLI functionality [#482](undefined/undefined/undefined/issues/482) [#475](undefined/undefined/undefined/issues/475) 67bf283
## [16.0.11](///compare/16.0.10...16.0.11) (2026-01-27)

### Features

* enhance JSON parsing and streaming response handling [#480](undefined/undefined/undefined/issues/480) b9e7933
* introduce AxMCPClient enhancements and new documentation fc2e2ec

## [16.0.11](///compare/16.0.9...16.0.10) (2026-01-27)

### Features

* enhance JSON parsing and streaming response handling [#480](undefined/undefined/undefined/issues/480) b9e7933
* introduce AxMCPClient enhancements and new documentation fc2e2ec
## [16.0.10](///compare/16.0.9...16.0.10) (2026-01-12)

## [16.0.10](///compare/16.0.8...16.0.9) (2026-01-12)
## [16.0.9](///compare/16.0.8...16.0.9) (2026-01-10)

## [16.0.9](///compare/16.0.7...16.0.8) (2026-01-10)
## [16.0.8](///compare/16.0.7...16.0.8) (2026-01-09)

## [16.0.8](///compare/16.0.6...16.0.7) (2026-01-09)
## [16.0.7](///compare/16.0.6...16.0.7) (2026-01-08)

## [16.0.7](///compare/16.0.5...16.0.6) (2026-01-08)
## [16.0.6](///compare/16.0.5...16.0.6) (2026-01-06)

### Bug Fixes

* use cache_control on a content block, not the content itself ([#479](undefined/undefined/undefined/issues/479)) 1542957

## [16.0.6](///compare/16.0.5...16.0.6) (2026-01-06)

### Bug Fixes

* use cache_control on a content block, not the content itself 1542957

## [16.0.5](///compare/16.0.4...16.0.5) (2026-01-06)

### Bug Fixes

* include cache_control for string-typed user messages 84aa908

### Features

* write metrics for cache write / read 54ce595

## [16.0.4](///compare/16.0.2...16.0.3) (2025-12-26)

### Features

* introduce `cacheBreakpoint` option for granular control over context caching in prompts and Anthropic API. 5100807
## [16.0.3](///compare/16.0.2...16.0.3) (2025-12-24)

### Features

* Add disclaimer to system prompt and separator to user query to clarify few-shot examples and demonstrations. b2a4ee1

## [16.0.3](///compare/16.0.1...16.0.2) (2025-12-24)

### Features

* Add disclaimer to system prompt and separator to user query to clarify few-shot examples and demonstrations. b2a4ee1
## [16.0.2](///compare/16.0.1...16.0.2) (2025-12-24)

### Features

* skip examples in prompt template rendering if missing input or output content 39c6abe

## [16.0.2](///compare/16.0.0...16.0.1) (2025-12-24)

### Features

* skip examples in prompt template rendering if missing input or output content 39c6abe
## [16.0.1](///compare/16.0.0...16.0.1) (2025-12-24)

### Features

* introduce AI context caching with breakpoint semantics for prompt hashing and update documentation. a9f38d3

## [16.0.1](///compare/15.1.1...16.0.0) (2025-12-24)

### Features

* introduce AI context caching with breakpoint semantics for prompt hashing and update documentation. a9f38d3
## [16.0.0](///compare/15.1.1...16.0.0) (2025-12-23)

### Features

* Add explicit context caching for AI models and refactor structured output example rendering in prompts. afe40c2

## [16.0.0](///compare/15.1.0...15.1.1) (2025-12-23)

### Features

* Add explicit context caching for AI models and refactor structured output example rendering in prompts. afe40c2
## [15.1.1](///compare/15.1.0...15.1.1) (2025-12-21)

### Features

* Enhance GEPA optimizer with new configuration options and structured optimization report f0ef34a

## [15.1.1](///compare/15.0.28...15.1.0) (2025-12-21)

### Features

* Enhance GEPA optimizer with new configuration options and structured optimization report f0ef34a
## [15.1.0](///compare/15.0.28...15.1.0) (2025-12-17)

## [15.1.0](///compare/15.0.27...15.0.28) (2025-12-17)
## [15.0.28](///compare/15.0.27...15.0.28) (2025-12-17)

### Features

* Add Gemini 3 Flash Preview model and update food search example to use it. f08335f

## [15.0.28](///compare/15.0.26...15.0.27) (2025-12-17)

### Features

* Add Gemini 3 Flash Preview model and update food search example to use it. f08335f
## [15.0.27](///compare/15.0.26...15.0.27) (2025-12-16)

### Features

* Add GPT-5 model definitions and update documentation to use strongly typed AI model enums. 3ff2546

### Bug Fixes

* correct Claude 4.5 Haiku model name in Vertex enum ([#474](undefined/undefined/undefined/issues/474)) 24f8e40

## [15.0.27](///compare/15.0.25...15.0.26) (2025-12-16)

### Features

* Add GPT-5 model definitions and update documentation to use strongly typed AI model enums. 3ff2546

### Bug Fixes

* correct Claude 4.5 Haiku model name in Vertex enum ([#474](undefined/undefined/undefined/issues/474)) 24f8e40
## [15.0.26](///compare/15.0.25...15.0.26) (2025-12-16)

### Features

* replace `AxLearnAgent` and `AxTuner` with `AxLearn` and update GEPA optimizer to include instruction in Pareto results. dc2742b

## [15.0.26](///compare/15.0.24...15.0.25) (2025-12-16)

### Features

* replace `AxLearnAgent` and `AxTuner` with `AxLearn` and update GEPA optimizer to include instruction in Pareto results. dc2742b
## [15.0.25](///compare/15.0.24...15.0.25) (2025-12-16)

### Features

* use strongly typed model enums in documentation examples 5201e9c

## [15.0.25](///compare/15.0.23...15.0.24) (2025-12-16)

### Features

* use strongly typed model enums in documentation examples 5201e9c
## [15.0.24](///compare/15.0.23...15.0.24) (2025-12-16)

### Features

* Introduce new DSP modules (agent, tuner, synth, judge), enhance API call retry logic with `Retry-After` header support, and update documentation and examples. 8c58902

## [15.0.24](///compare/15.0.22...15.0.23) (2025-12-16)

### Features

* Introduce new DSP modules (agent, tuner, synth, judge), enhance API call retry logic with `Retry-After` header support, and update documentation and examples. 8c58902
## [15.0.23](///compare/15.0.22...15.0.23) (2025-12-15)

## [15.0.23](///compare/15.0.21...15.0.22) (2025-12-15)
## [15.0.22](///compare/15.0.21...15.0.22) (2025-12-14)

### Features

* **azure-openai:** add structured outputs support ([#473](undefined/undefined/undefined/issues/473)) a246518

## [15.0.22](///compare/15.0.20...15.0.21) (2025-12-14)

### Features

* **azure-openai:** add structured outputs support ([#473](undefined/undefined/undefined/issues/473)) a246518
## [15.0.21](///compare/15.0.20...15.0.21) (2025-12-13)

### Features

* Introduce `AxTokenLimitError` for specific token limit detection in AI API calls and add configuration for retrying on such errors. 69539df

## [15.0.21](///compare/15.0.19...15.0.20) (2025-12-13)

### Features

* Introduce `AxTokenLimitError` for specific token limit detection in AI API calls and add configuration for retrying on such errors. 69539df
## [15.0.20](///compare/15.0.19...15.0.20) (2025-12-13)

## [15.0.20](///compare/15.0.18...15.0.19) (2025-12-13)

### Features

* Implement infrastructure-level retry for service network, status, and timeout errors, adjusting default retry and step limits. 807ad4f

## [15.0.19](///compare/15.0.17...15.0.18) (2025-12-13)

### Features

* Implement infrastructure-level retry for service network, status, and timeout errors, adjusting default retry and step limits. 807ad4f
## [15.0.18](///compare/15.0.17...15.0.18) (2025-12-12)

### Features

* Improve streaming error handling by distinguishing validation from parsing errors, optimize signature complex field detection, and add API request debug logging. 117e7d2
* Improve streaming retry logic by resetting state and committed values, and clarify complex field detection for output signatures. 0bf9d87

## [15.0.18](///compare/15.0.16...15.0.17) (2025-12-12)

### Features

* Improve streaming error handling by distinguishing validation from parsing errors, optimize signature complex field detection, and add API request debug logging. 117e7d2
* Improve streaming retry logic by resetting state and committed values, and clarify complex field detection for output signatures. 0bf9d87
## [15.0.17](///compare/15.0.16...15.0.17) (2025-12-11)

### Features

* Prevent stream duplication on retry by tracking committed values and yielding only effective deltas. 98a8480

## [15.0.17](///compare/15.0.15...15.0.16) (2025-12-11)

### Features

* Prevent stream duplication on retry by tracking committed values and yielding only effective deltas. 98a8480
## [15.0.16](///compare/15.0.15...15.0.16) (2025-12-11)

### Bug Fixes

* Prevent streaming structured output duplication by refining delta calculation and resetting retry states. 946349f

## [15.0.16](///compare/15.0.14...15.0.15) (2025-12-11)

### Bug Fixes

* Prevent streaming structured output duplication by refining delta calculation and resetting retry states. 946349f
## [15.0.15](///compare/15.0.14...15.0.15) (2025-12-11)

### Features

* Enhance AI balancer with capability-based service selection and aggregated features/metrics across services. d4acef2

### Bug Fixes

* **ace:** Refine reflector to use only input fields ([#464](undefined/undefined/undefined/issues/464)) 695dbf0

## [15.0.15](///compare/15.0.13...15.0.14) (2025-12-11)

### Features

* Enhance AI balancer with capability-based service selection and aggregated features/metrics across services. d4acef2

### Bug Fixes

* **ace:** Refine reflector to use only input fields ([#464](undefined/undefined/undefined/issues/464)) 695dbf0
## [15.0.14](///compare/15.0.13...15.0.14) (2025-12-10)

### Bug Fixes

* ensure streaming partial memory blocks only merge with other partial blocks, otherwise append as new. 5679412

## [15.0.14](///compare/15.0.12...15.0.13) (2025-12-10)

### Bug Fixes

* ensure streaming partial memory blocks only merge with other partial blocks, otherwise append as new. 5679412
## [15.0.13](///compare/15.0.12...15.0.13) (2025-12-10)

### Features

* add support for Claude 4.5 Opus model ([#467](undefined/undefined/undefined/issues/467)) 88c573b

### Bug Fixes

* **dsp:** correctly extract instruction from signature in GEPA optimizer ([#466](undefined/undefined/undefined/issues/466)) 76e7a6c, closes #463

## [15.0.13](///compare/15.0.11...15.0.12) (2025-12-10)

### Features

* add support for Claude 4.5 Opus model ([#467](undefined/undefined/undefined/issues/467)) 88c573b

### Bug Fixes

* **dsp:** correctly extract instruction from signature in GEPA optimizer ([#466](undefined/undefined/undefined/issues/466)) 76e7a6c, closes #463
## [15.0.12](///compare/15.0.11...15.0.12) (2025-12-10)

### Features

* introduce AxThoughtBlockItem type and refactor thought block handling across AI models ad92200

## [15.0.12](///compare/15.0.10...15.0.11) (2025-12-10)

### Features

* introduce AxThoughtBlockItem type and refactor thought block handling across AI models ad92200
## [15.0.11](///compare/15.0.10...15.0.11) (2025-12-09)

## [15.0.11](///compare/15.0.9...15.0.10) (2025-12-09)
## [15.0.10](///compare/15.0.9...15.0.10) (2025-12-09)

### Features

* add support for structured outputs across various AI models and enhance error handling for complex fields 816484c

## [15.0.10](///compare/15.0.8...15.0.9) (2025-12-09)

### Features

* add support for structured outputs across various AI models and enhance error handling for complex fields 816484c
## [15.0.9](///compare/15.0.8...15.0.9) (2025-12-08)

### Bug Fixes

* **anthropic:** remove unsupported structured-outputs beta header for Vertex AI ([#462](undefined/undefined/undefined/issues/462)) 8420adb
* improved ax generate error bebf924

## [15.0.9](///compare/15.0.7...15.0.8) (2025-12-08)

### Bug Fixes

* **anthropic:** remove unsupported structured-outputs beta header for Vertex AI ([#462](undefined/undefined/undefined/issues/462)) 8420adb
* improved ax generate error bebf924
## [15.0.8](///compare/15.0.7...15.0.8) (2025-12-02)

### Features

* **dsp:** Separate structured output example input fields with newlines and allow missing required fields during structured output validation in response processing. 6150f36

## [15.0.8](///compare/15.0.6...15.0.7) (2025-12-02)

### Features

* **dsp:** Separate structured output example input fields with newlines and allow missing required fields during structured output validation in response processing. 6150f36
## [15.0.7](///compare/15.0.6...15.0.7) (2025-12-01)

### Features

* enhance structured output handling with distinct extraction modes and improved prompt rendering for complex fields 7ad07fe

## [15.0.7](///compare/15.0.5...15.0.6) (2025-12-01)

### Features

* enhance structured output handling with distinct extraction modes and improved prompt rendering for complex fields 7ad07fe
## [15.0.6](///compare/15.0.5...15.0.6) (2025-12-01)

### Features

* Enhance complex object and JSON extraction, add validation tests, and improve error messages with LLM output. 100ed60

## [15.0.6](///compare/15.0.4...15.0.5) (2025-12-01)

### Features

* Enhance complex object and JSON extraction, add validation tests, and improve error messages with LLM output. 100ed60
## [15.0.5](///compare/15.0.4...15.0.5) (2025-11-29)

### Features

* add documentation for AWS Bedrock, Vercel AI SDK, and Ax Tools packages. 95962ae
* **anthropic:** add validation for arbitrary json objects in structured outputs ([#459](undefined/undefined/undefined/issues/459)) 7db81c5

## [15.0.5](///compare/15.0.3...15.0.4) (2025-11-29)

### Features

* add documentation for AWS Bedrock, Vercel AI SDK, and Ax Tools packages. 95962ae
* **anthropic:** add validation for arbitrary json objects in structured outputs ([#459](undefined/undefined/undefined/issues/459)) 7db81c5
## [15.0.4](///compare/15.0.3...15.0.4) (2025-11-28)

### Features

* **mipro:** Expand MIPROv2 optimizer to tune instructions and examples ([#453](undefined/undefined/undefined/issues/453)) 2f3e6ac

### Bug Fixes

* **ace:** Ensure only input fields are passed to curator ([#456](undefined/undefined/undefined/issues/456)) 8c0c13f
* allow f.object().array() as input field ([#452](undefined/undefined/undefined/issues/452)) d36ddd6
* **anthropic:** add anthropic-beta header for web-search on Vertex AI ([#457](undefined/undefined/undefined/issues/457)) df13f8c
* build issue 71b5ae8

## [15.0.4](///compare/15.0.2...15.0.3) (2025-11-28)

### Features

* **mipro:** Expand MIPROv2 optimizer to tune instructions and examples ([#453](undefined/undefined/undefined/issues/453)) 2f3e6ac

### Bug Fixes

* **ace:** Ensure only input fields are passed to curator ([#456](undefined/undefined/undefined/issues/456)) 8c0c13f
* allow f.object().array() as input field ([#452](undefined/undefined/undefined/issues/452)) d36ddd6
* **anthropic:** add anthropic-beta header for web-search on Vertex AI ([#457](undefined/undefined/undefined/issues/457)) df13f8c
* build issue 71b5ae8
## [15.0.3](///compare/15.0.2...15.0.3) (2025-11-24)

### Features

* Update Anthropic schema cleaning to preserve `default`, `oneOf`, `anyOf`, `allOf` and conditionally remove `additionalProperties`. dbc419c

## [15.0.3](///compare/15.0.1...15.0.2) (2025-11-24)

### Features

* Update Anthropic schema cleaning to preserve `default`, `oneOf`, `anyOf`, `allOf` and conditionally remove `additionalProperties`. dbc419c
## [15.0.2](///compare/15.0.1...15.0.2) (2025-11-23)

### Features

* Implement and document parallel function calling for Google Gemini. cb1a310

## [15.0.2](///compare/15.0.0...15.0.1) (2025-11-23)

### Features

* Implement and document parallel function calling for Google Gemini. cb1a310
## [15.0.1](///compare/15.0.0...15.0.1) (2025-11-22)

### Features

* Introduce `AxSignature.hasComplexFields()` for consistent complex type detection and update example documentation. b1dc107

## [15.0.1](///compare/14.0.44...15.0.0) (2025-11-22)

### Features

* Introduce `AxSignature.hasComplexFields()` for consistent complex type detection and update example documentation. b1dc107
* Introduce structured (XML) prompt generation with format protection and tests, and remove individual streaming result logging. f04c787

## [15.0.0](///compare/14.0.43...14.0.44) (2025-11-22)

### Features

* Introduce structured (XML) prompt generation with format protection and tests, and remove individual streaming result logging. f04c787
## [14.0.44](///compare/14.0.43...14.0.44) (2025-11-22)

### Features

* **anthropic:** update and align Vertex AI model maxTokens values ([#426](undefined/undefined/undefined/issues/426)) f042d7b

## [14.0.44](///compare/14.0.42...14.0.43) (2025-11-22)

### Features

* **anthropic:** update and align Vertex AI model maxTokens values ([#426](undefined/undefined/undefined/issues/426)) f042d7b
## [14.0.43](///compare/14.0.42...14.0.43) (2025-11-22)

### Features

* Enable Anthropic web search by updating beta headers and removing tool filtering, and reorder validator imports. 60a5663

### Bug Fixes

* **vertex:** use correct Vertex AI endpoint for global region ([#428](undefined/undefined/undefined/issues/428)) 1466bc7

## [14.0.43](///compare/14.0.41...14.0.42) (2025-11-22)

### Features

* Enable Anthropic web search by updating beta headers and removing tool filtering, and reorder validator imports. 60a5663

### Bug Fixes

* **vertex:** use correct Vertex AI endpoint for global region ([#428](undefined/undefined/undefined/issues/428)) 1466bc7
## [14.0.42](///compare/14.0.41...14.0.42) (2025-11-22)

## [14.0.42](///compare/14.0.40...14.0.41) (2025-11-22)
## [14.0.41](///compare/14.0.40...14.0.41) (2025-11-21)

### Features

* Add date and datetime field types and clarify dual syntax for format validators across documentation. f1abcab
* Introduce date and datetime format validators, add dedicated email type factory, and clarify format validation syntax in documentation. c9b16a6

## [14.0.41](///compare/14.0.39...14.0.40) (2025-11-21)

### Features

* Add date and datetime field types and clarify dual syntax for format validators across documentation. f1abcab
* Introduce date and datetime format validators, add dedicated email type factory, and clarify format validation syntax in documentation. c9b16a6
## [14.0.40](///compare/14.0.39...14.0.40) (2025-11-21)

### Features

* **anthropic:** implement extended thinking signature handling in streaming mode c73646f
* **gemini:** add Gemini 3 support with thought signatures and function calling 7b6a499
* **validation:** introduce Zod-like validation constraints for structured outputs a15e5b6

### Bug Fixes

* **anthropic:** correct prompt caching property to cache_control 20606c7
* **anthropic:** support streaming cache usage and remove beta header 8fe2bfc
* buid issues 571b775
* build issues 3fa583c

## [14.0.40](///compare/14.0.38...14.0.39) (2025-11-21)

### Features

* **anthropic:** implement extended thinking signature handling in streaming mode c73646f
* **gemini:** add Gemini 3 support with thought signatures and function calling 7b6a499
* **validation:** introduce Zod-like validation constraints for structured outputs a15e5b6

### Bug Fixes

* **anthropic:** correct prompt caching property to cache_control 20606c7
* **anthropic:** support streaming cache usage and remove beta header 8fe2bfc
* buid issues 571b775
* build issues 3fa583c
## [14.0.39](///compare/14.0.38...14.0.39) (2025-11-05)

### Bug Fixes

* **api:** improve handling of empty function parameters in Anthropic, Cohere, and Google Gemini APIs e901fdc

## [14.0.39](https://github.com/ax-llm/ax/compare/14.0.37...14.0.38) (2025-11-05)

### Bug Fixes

* **api:** improve handling of empty function parameters in Anthropic, Cohere, and Google Gemini APIs ([e901fdc](https://github.com/ax-llm/ax/commit/e901fdc675951b67aca7c923885f757d8a152c7a))
## [14.0.38](https://github.com/ax-llm/ax/compare/14.0.37...14.0.38) (2025-11-05)

### Features

* **api:** enhance function parameter handling and schema validation across multiple AI integrations ([e593e75](https://github.com/ax-llm/ax/commit/e593e7521ec231f2e9841babe8cb4dfb13bd2512))
* **caching:** implement caching functionality in AxGen and AxFlow for improved performance ([18158d9](https://github.com/ax-llm/ax/commit/18158d9ba17f749e98a7814072743911131b84a1))
* **flow:** add description and toFunction methods for enhanced flow metadata ([54dfaca](https://github.com/ax-llm/ax/commit/54dfacac6f609016f2306a02f76d28cfd726028a))

### Bug Fixes

* Hardcode error class names to prevent minification issues ([#421](https://github.com/ax-llm/ax/issues/421)) ([5267340](https://github.com/ax-llm/ax/commit/5267340459564a576b6f1c9fddff785588e78af5))

## [14.0.38](https://github.com/ax-llm/ax/compare/14.0.36...14.0.37) (2025-11-05)

### Features

* **api:** enhance function parameter handling and schema validation across multiple AI integrations ([e593e75](https://github.com/ax-llm/ax/commit/e593e7521ec231f2e9841babe8cb4dfb13bd2512))
* **caching:** implement caching functionality in AxGen and AxFlow for improved performance ([18158d9](https://github.com/ax-llm/ax/commit/18158d9ba17f749e98a7814072743911131b84a1))
* **flow:** add description and toFunction methods for enhanced flow metadata ([54dfaca](https://github.com/ax-llm/ax/commit/54dfacac6f609016f2306a02f76d28cfd726028a))

### Bug Fixes

* Hardcode error class names to prevent minification issues ([#421](https://github.com/ax-llm/ax/issues/421)) ([5267340](https://github.com/ax-llm/ax/commit/5267340459564a576b6f1c9fddff785588e78af5))
## [14.0.37](https://github.com/ax-llm/ax/compare/14.0.36...14.0.37) (2025-10-22)

## [14.0.37](https://github.com/ax-llm/ax/compare/14.0.35...14.0.36) (2025-10-22)
## [14.0.36](https://github.com/ax-llm/ax/compare/14.0.35...14.0.36) (2025-10-22)

### Features

* **anthropic:** add Claude 4.5 Haiku model and update logging for thought display ([2d84bc2](https://github.com/ax-llm/ax/commit/2d84bc266d26b3338d68fc24a86e6faaf78288b0))
* **anthropic:** add Claude 4.5 Sonnet model with pricing and token limits ([af101b4](https://github.com/ax-llm/ax/commit/af101b42593abc668877099fed474421d81de6a5))

## [14.0.36](https://github.com/ax-llm/ax/compare/14.0.34...14.0.35) (2025-10-22)

### Features

* **anthropic:** add Claude 4.5 Haiku model and update logging for thought display ([2d84bc2](https://github.com/ax-llm/ax/commit/2d84bc266d26b3338d68fc24a86e6faaf78288b0))
* **anthropic:** add Claude 4.5 Sonnet model with pricing and token limits ([af101b4](https://github.com/ax-llm/ax/commit/af101b42593abc668877099fed474421d81de6a5))
## [14.0.35](https://github.com/ax-llm/ax/compare/14.0.34...14.0.35) (2025-10-19)

### Features

* add AWS Bedrock provider integration ([#395](https://github.com/ax-llm/ax/issues/395)) ([6ce7eb3](https://github.com/ax-llm/ax/commit/6ce7eb3219c9936bec0916ca0572be9fe17c670c))

### Bug Fixes

* **google-gemini:** align Google Maps grounding types/options and retrievalConfig with Gemini api ([#393](https://github.com/ax-llm/ax/issues/393)) ([b44f534](https://github.com/ax-llm/ax/commit/b44f5340a603475728179e75baa7415767eec1e9))

## [14.0.35](https://github.com/ax-llm/ax/compare/14.0.33...14.0.34) (2025-10-19)

### Features

* add AWS Bedrock provider integration ([#395](https://github.com/ax-llm/ax/issues/395)) ([6ce7eb3](https://github.com/ax-llm/ax/commit/6ce7eb3219c9936bec0916ca0572be9fe17c670c))

### Bug Fixes

* **google-gemini:** align Google Maps grounding types/options and retrievalConfig with Gemini api ([#393](https://github.com/ax-llm/ax/issues/393)) ([b44f534](https://github.com/ax-llm/ax/commit/b44f5340a603475728179e75baa7415767eec1e9))
## [14.0.34](https://github.com/ax-llm/ax/compare/14.0.33...14.0.34) (2025-10-18)

## [14.0.34](https://github.com/ax-llm/ax/compare/14.0.32...14.0.33) (2025-10-18)
## [14.0.33](https://github.com/ax-llm/ax/compare/14.0.32...14.0.33) (2025-10-17)

### Features

* add GPT-4.1 nano model support ([#387](https://github.com/ax-llm/ax/issues/387)) ([0aa4aa2](https://github.com/ax-llm/ax/commit/0aa4aa2ceed1ba61106711baed6ce962cf2eb604))

## [14.0.33](https://github.com/ax-llm/ax/compare/14.0.32...14.0.33) (2025-10-17)

### Features

* Add support for caching the system prompt in Anthropic models ([#391](https://github.com/ax-llm/ax/pull/391)) ([92afffc](https://github.com/ax-llm/ax/commit/92afffcf1a60edecd0c0804eae2c0d6deda8d508))
* docs: Created docs/ARCHITECTURE.md ([#390](https://github.com/ax-llm/ax/pull/390)) ([61ac71b](https://github.com/ax-llm/ax/commit/61ac71b6a61fda7e91c18460f8482fd2267a2e29))
* feat: add GPT-4.1 nano model support ([#387](https://github.com/ax-llm/ax/pull/387)) ([0aa4aa2](https://github.com/ax-llm/ax/commit/0aa4aa2ceed1ba61106711baed6ce962cf2eb604))

## [14.0.32](https://github.com/ax-llm/ax/compare/14.0.30...14.0.31) (2025-10-15)

### Features

* **ace:** implement agentic context engineering ([#386](https://github.com/ax-llm/ax/issues/386)) ([a54eb50](https://github.com/ax-llm/ax/commit/a54eb50b9069eae5e00d02c683cdce459e7d596c))

### Bug Fixes

* **flow/planner:** update regex for block splitting to handle whitespace correctly ([7e8ad09](https://github.com/ax-llm/ax/commit/7e8ad09ff599c8660f0754c4b71c28bee2026774))
* handle numeric zero values in prompt field rendering ([#382](https://github.com/ax-llm/ax/issues/382)) ([d06849c](https://github.com/ax-llm/ax/commit/d06849c70c1cc2d61f5ab82c435fbbc3b027e190))
* log originating error in balancer ([#385](https://github.com/ax-llm/ax/issues/385)) ([70ca5e5](https://github.com/ax-llm/ax/commit/70ca5e563f706a00d9a858dbdae5f4b047b94c8f))
* **rag): guard undefined retrievalResults and guarantee non-empty finalContext; fix(flow/planner:** avoid executing map transforms during analysis to prevent mock side effects; build: green across workspaces; closes [#323](https://github.com/ax-llm/ax/issues/323) ([d1bce5b](https://github.com/ax-llm/ax/commit/d1bce5b5f2bb32100a8fb2c90041ff0979d30a8b))
## [14.0.31](https://github.com/ax-llm/ax/compare/14.0.30...14.0.31) (2025-10-08)

### Features

* add thoughtBlock to AxChatResponseResult and enhance validation ([7b49f65](https://github.com/ax-llm/ax/commit/7b49f65bf5474fb1c9e337e76e231c74ad21da98))

## [14.0.31](https://github.com/ax-llm/ax/compare/14.0.29...14.0.30) (2025-10-08)

### Features

* add thoughtBlock to AxChatResponseResult and enhance validation ([7b49f65](https://github.com/ax-llm/ax/commit/7b49f65bf5474fb1c9e337e76e231c74ad21da98))
## [14.0.30](https://github.com/ax-llm/ax/compare/14.0.29...14.0.30) (2025-10-07)

### Features

* enhance README with new examples and Fluent Signature API ([5cd30db](https://github.com/ax-llm/ax/commit/5cd30db98271646f3119d2fd96a734063928cc80))

## [14.0.30](https://github.com/ax-llm/ax/compare/14.0.28...14.0.29) (2025-10-07)

### Features

* enhance README with new examples and Fluent Signature API ([5cd30db](https://github.com/ax-llm/ax/commit/5cd30db98271646f3119d2fd96a734063928cc80))
## [14.0.29](https://github.com/ax-llm/ax/compare/14.0.28...14.0.29) (2025-10-04)

### Bug Fixes

* add GEPA feedback type hooks to AxCompileOptions ([#376](https://github.com/ax-llm/ax/issues/376)) ([4700c7e](https://github.com/ax-llm/ax/commit/4700c7e8e92ea3c52d9dd34020d466501dbef6bc))

## [14.0.29](https://github.com/ax-llm/ax/compare/14.0.27...14.0.28) (2025-10-04)

### Bug Fixes

* add GEPA feedback type hooks to AxCompileOptions ([#376](https://github.com/ax-llm/ax/issues/376)) ([4700c7e](https://github.com/ax-llm/ax/commit/4700c7e8e92ea3c52d9dd34020d466501dbef6bc))
## [14.0.28](https://github.com/ax-llm/ax/compare/14.0.27...14.0.28) (2025-09-28)

### Features

* add support flags for Google Gemini models ([5e785f0](https://github.com/ax-llm/ax/commit/5e785f0691c3d9e85adb63ef5e974acca6201d3a))

## [14.0.28](https://github.com/ax-llm/ax/compare/14.0.26...14.0.27) (2025-09-28)

### Features

* add support flags for Google Gemini models ([5e785f0](https://github.com/ax-llm/ax/commit/5e785f0691c3d9e85adb63ef5e974acca6201d3a))
## [14.0.27](https://github.com/ax-llm/ax/compare/14.0.26...14.0.27) (2025-09-28)

### Features

* add GEPA multi-objective optimization example and enhance documentation ([f64189c](https://github.com/ax-llm/ax/commit/f64189c45844ae7149f0d35a4aa7f7b792ba0a5d))
* integrate Vercel AI SDK v5 support and update dependencies ([3acb408](https://github.com/ax-llm/ax/commit/3acb4085e14b8845f075c84bdd55c5e9277b6b71))

### Bug Fixes

* clean up code formatting and improve consistency in examples ([f4af653](https://github.com/ax-llm/ax/commit/f4af653a737b7c0532c0e7d06066c6c5bfcb045e))

## [14.0.27](https://github.com/ax-llm/ax/compare/14.0.25...14.0.26) (2025-09-28)

### Features

* add GEPA multi-objective optimization example and enhance documentation ([f64189c](https://github.com/ax-llm/ax/commit/f64189c45844ae7149f0d35a4aa7f7b792ba0a5d))
* integrate Vercel AI SDK v5 support and update dependencies ([3acb408](https://github.com/ax-llm/ax/commit/3acb4085e14b8845f075c84bdd55c5e9277b6b71))

### Bug Fixes

* clean up code formatting and improve consistency in examples ([f4af653](https://github.com/ax-llm/ax/commit/f4af653a737b7c0532c0e7d06066c6c5bfcb045e))
## [14.0.26](https://github.com/ax-llm/ax/compare/14.0.25...14.0.26) (2025-09-15)

### Features

* enhance debug handling in AxBaseAI and global settings ([355640b](https://github.com/ax-llm/ax/commit/355640bd6a47730f8a05bb535d8f03b43d2f8f7f))

## [14.0.26](https://github.com/ax-llm/ax/compare/14.0.24...14.0.25) (2025-09-15)

### Features

* enhance debug handling in AxBaseAI and global settings ([355640b](https://github.com/ax-llm/ax/commit/355640bd6a47730f8a05bb535d8f03b43d2f8f7f))
## [14.0.25](https://github.com/ax-llm/ax/compare/14.0.24...14.0.25) (2025-09-14)

### Features

* enhance assertion capabilities in AxGen and documentation updates ([2770a07](https://github.com/ax-llm/ax/commit/2770a074adc883b55dfc655d3d46143dbf00c017))
* GEPA: enable optimizedProgram interface to mirror MiPRO ([#350](https://github.com/ax-llm/ax/issues/350)) ([9b1ae9a](https://github.com/ax-llm/ax/commit/9b1ae9a21c62ec913bad5dc38481a271e3facac2))
* unify GEPA and MiPRO interfaces for consistent optimization workflows ([7cf8e28](https://github.com/ax-llm/ax/commit/7cf8e289dbc38af57cb08e6e92b0ebbbcb2516bb))

## [14.0.25](https://github.com/ax-llm/ax/compare/14.0.23...14.0.24) (2025-09-14)

### Features

* enhance assertion capabilities in AxGen and documentation updates ([2770a07](https://github.com/ax-llm/ax/commit/2770a074adc883b55dfc655d3d46143dbf00c017))
* GEPA: enable optimizedProgram interface to mirror MiPRO ([#350](https://github.com/ax-llm/ax/issues/350)) ([9b1ae9a](https://github.com/ax-llm/ax/commit/9b1ae9a21c62ec913bad5dc38481a271e3facac2))
* unify GEPA and MiPRO interfaces for consistent optimization workflows ([7cf8e28](https://github.com/ax-llm/ax/commit/7cf8e289dbc38af57cb08e6e92b0ebbbcb2516bb))
## [14.0.24](https://github.com/ax-llm/ax/compare/14.0.23...14.0.24) (2025-09-13)

### Bug Fixes

* enhance error handling in AxGen class ([aa76a28](https://github.com/ax-llm/ax/commit/aa76a28d8a77b933acce9ef1a075ce5b5027d37a))

## [14.0.24](https://github.com/ax-llm/ax/compare/14.0.22...14.0.23) (2025-09-13)

### Bug Fixes

* enhance error handling in AxGen class ([aa76a28](https://github.com/ax-llm/ax/commit/aa76a28d8a77b933acce9ef1a075ce5b5027d37a))
## [14.0.23](https://github.com/ax-llm/ax/compare/14.0.22...14.0.23) (2025-09-12)

### Features

* update fluent API to remove nested helper functions and enhance type inference ([15250f2](https://github.com/ax-llm/ax/commit/15250f26aa5dc9f6acb6648e0f4a8ba0d9f206ed))

## [14.0.23](https://github.com/ax-llm/ax/compare/14.0.21...14.0.22) (2025-09-12)

### Features

* update fluent API to remove nested helper functions and enhance type inference ([15250f2](https://github.com/ax-llm/ax/commit/15250f26aa5dc9f6acb6648e0f4a8ba0d9f206ed))
## [14.0.22](https://github.com/ax-llm/ax/compare/14.0.21...14.0.22) (2025-09-12)

### Bug Fixes

* refactor MCP transport imports and update documentation ([ee4d976](https://github.com/ax-llm/ax/commit/ee4d976c2ac3a71f197978379e741a8fc5dae585))

## [14.0.22](https://github.com/ax-llm/ax/compare/14.0.20...14.0.21) (2025-09-12)

### Bug Fixes

* refactor MCP transport imports and update documentation ([ee4d976](https://github.com/ax-llm/ax/commit/ee4d976c2ac3a71f197978379e741a8fc5dae585))
## [14.0.21](https://github.com/ax-llm/ax/compare/14.0.20...14.0.21) (2025-09-11)

### ⚠ BREAKING CHANGES

* **gepa:** compile now throws if `options.maxMetricCalls` is absent or non-positive.

* fix(gepa): only skip reflective after an evaluated merge attempt\n\nAlign single-module merge gating with the reference engine so reflective mutation is skipped only when a merge is actually attempted, improving behavioral parity and avoiding lost reflective iterations when no valid merge pair exists.

* docs(optimize): migrate multi-objective docs to GEPA/GEPA-Flow using compile (remove compilePareto)

### Features

* enhance AxExamples utility and improve fluent API type inference ([45897fc](https://github.com/ax-llm/ax/commit/45897fc19404197a01c91ba7b7aaa9c54c1e03cc))
* **gepa:** GEPA/GEPA-Flow Pareto optimizers + docs alignment ([#341](https://github.com/ax-llm/ax/issues/341)) ([f61c18a](https://github.com/ax-llm/ax/commit/f61c18a9b11a6e36f783f6937c0e9104cf168c1f))
* **mcp:** OAuth 2.1 for HTTP/SSE transports + Notion OAuth examples ([#340](https://github.com/ax-llm/ax/issues/340)) ([4f8c922](https://github.com/ax-llm/ax/commit/4f8c922627ad6d973c42615d8eb0d7f9e7a649d1))

### Bug Fixes

* enhance memory tag validation and retry logic in tests ([adecf29](https://github.com/ax-llm/ax/commit/adecf29904f8df5d634f6eedbca1ad7c6927e56f))
* improve code formatting and cleanup in tests and base AI implementation ([eba5f39](https://github.com/ax-llm/ax/commit/eba5f393f1c397dba7848992fefa8157e8cd3531))
* improve token budget handling and update model references ([6868de6](https://github.com/ax-llm/ax/commit/6868de61805bd42d8c04f39a65edd72363a29cad))
* streamline memory tag management and improve test coverage ([870ebe2](https://github.com/ax-llm/ax/commit/870ebe2b4e7ef604fb8976acfe9d5cd41ac6ec62))
* update AxMultiMetricFn type definition and clean up imports ([06c3960](https://github.com/ax-llm/ax/commit/06c3960fc86a3f27d92e65e6ff4bba21242a7102))
* update typedef to support async version ([#294](https://github.com/ax-llm/ax/issues/294)) ([45f07a2](https://github.com/ax-llm/ax/commit/45f07a2ec32255fe1f9adb888358aa11ffad354a))

## [14.0.21](https://github.com/ax-llm/ax/compare/14.0.19...14.0.20) (2025-09-11)

### ⚠ BREAKING CHANGES

* **gepa:** compile now throws if `options.maxMetricCalls` is absent or non-positive.

* fix(gepa): only skip reflective after an evaluated merge attempt\n\nAlign single-module merge gating with the reference engine so reflective mutation is skipped only when a merge is actually attempted, improving behavioral parity and avoiding lost reflective iterations when no valid merge pair exists.

* docs(optimize): migrate multi-objective docs to GEPA/GEPA-Flow using compile (remove compilePareto)

### Features

* enhance AxExamples utility and improve fluent API type inference ([45897fc](https://github.com/ax-llm/ax/commit/45897fc19404197a01c91ba7b7aaa9c54c1e03cc))
* **gepa:** GEPA/GEPA-Flow Pareto optimizers + docs alignment ([#341](https://github.com/ax-llm/ax/issues/341)) ([f61c18a](https://github.com/ax-llm/ax/commit/f61c18a9b11a6e36f783f6937c0e9104cf168c1f))
* **mcp:** OAuth 2.1 for HTTP/SSE transports + Notion OAuth examples ([#340](https://github.com/ax-llm/ax/issues/340)) ([4f8c922](https://github.com/ax-llm/ax/commit/4f8c922627ad6d973c42615d8eb0d7f9e7a649d1))

### Bug Fixes

* enhance memory tag validation and retry logic in tests ([adecf29](https://github.com/ax-llm/ax/commit/adecf29904f8df5d634f6eedbca1ad7c6927e56f))
* improve code formatting and cleanup in tests and base AI implementation ([eba5f39](https://github.com/ax-llm/ax/commit/eba5f393f1c397dba7848992fefa8157e8cd3531))
* improve token budget handling and update model references ([6868de6](https://github.com/ax-llm/ax/commit/6868de61805bd42d8c04f39a65edd72363a29cad))
* streamline memory tag management and improve test coverage ([870ebe2](https://github.com/ax-llm/ax/commit/870ebe2b4e7ef604fb8976acfe9d5cd41ac6ec62))
* update AxMultiMetricFn type definition and clean up imports ([06c3960](https://github.com/ax-llm/ax/commit/06c3960fc86a3f27d92e65e6ff4bba21242a7102))
* update typedef to support async version ([#294](https://github.com/ax-llm/ax/issues/294)) ([45f07a2](https://github.com/ax-llm/ax/commit/45f07a2ec32255fe1f9adb888358aa11ffad354a))
## [14.0.20](https://github.com/ax-llm/ax/compare/14.0.19...14.0.20) (2025-09-02)

## [14.0.20](https://github.com/ax-llm/ax/compare/14.0.18...14.0.19) (2025-09-02)
## [14.0.19](https://github.com/ax-llm/ax/compare/14.0.18...14.0.19) (2025-08-29)

### Bug Fixes

* bind provider implementation methods to preserve context ([86c92e4](https://github.com/ax-llm/ax/commit/86c92e4f536cd85371ef45bd15b5f6209072adaf))

## [14.0.19](https://github.com/ax-llm/ax/compare/14.0.17...14.0.18) (2025-08-29)

### Bug Fixes

* bind provider implementation methods to preserve context ([86c92e4](https://github.com/ax-llm/ax/commit/86c92e4f536cd85371ef45bd15b5f6209072adaf))
## [14.0.18](https://github.com/ax-llm/ax/compare/14.0.17...14.0.18) (2025-08-28)

## [14.0.18](https://github.com/ax-llm/ax/compare/14.0.16...14.0.17) (2025-08-28)
## [14.0.17](https://github.com/ax-llm/ax/compare/14.0.16...14.0.17) (2025-08-28)

### Features

* introduce AxStopFunctionCallException and enhance function call handling ([71e8e63](https://github.com/ax-llm/ax/commit/71e8e633f0f1a009b86552a3046967221ae29038))

### Bug Fixes

* refine field extraction logic and update test cases ([d9d9836](https://github.com/ax-llm/ax/commit/d9d983666a658b9d21b33757a063b5389296d512))

## [14.0.17](https://github.com/ax-llm/ax/compare/14.0.15...14.0.16) (2025-08-28)

### Features

* introduce AxStopFunctionCallException and enhance function call handling ([71e8e63](https://github.com/ax-llm/ax/commit/71e8e633f0f1a009b86552a3046967221ae29038))

### Bug Fixes

* refine field extraction logic and update test cases ([d9d9836](https://github.com/ax-llm/ax/commit/d9d983666a658b9d21b33757a063b5389296d512))
## [14.0.16](https://github.com/ax-llm/ax/compare/14.0.15...14.0.16) (2025-08-13)

### Bug Fixes

* enhance debug parameter handling in response processing ([0d36063](https://github.com/ax-llm/ax/commit/0d36063386241dc5626dc96a8c2179e0f5721f4c))

## [14.0.16](https://github.com/ax-llm/ax/compare/14.0.14...14.0.15) (2025-08-13)

### Bug Fixes

* enhance debug parameter handling in response processing ([0d36063](https://github.com/ax-llm/ax/commit/0d36063386241dc5626dc96a8c2179e0f5721f4c))
## [14.0.15](https://github.com/ax-llm/ax/compare/14.0.14...14.0.15) (2025-08-13)

### Features

* add comprehensive documentation for AI providers, DSPy signatures, and AxFlow ([09c324a](https://github.com/ax-llm/ax/commit/09c324a26d91c87fed66ae5910a4b2e265028e64))
* enhance documentation with new Examples Guide and improved links ([e39300b](https://github.com/ax-llm/ax/commit/e39300be36efa59267a98508cfde51c9ab5022a0))
* enhance logging functionality with ChatResponseCitations support ([ec87e3a](https://github.com/ax-llm/ax/commit/ec87e3a5af7e17293ccd0528c57220d464ca5c73))

## [14.0.15](https://github.com/ax-llm/ax/compare/14.0.13...14.0.14) (2025-08-13)

### Features

* add comprehensive documentation for AI providers, DSPy signatures, and AxFlow ([09c324a](https://github.com/ax-llm/ax/commit/09c324a26d91c87fed66ae5910a4b2e265028e64))
* enhance documentation with new Examples Guide and improved links ([e39300b](https://github.com/ax-llm/ax/commit/e39300be36efa59267a98508cfde51c9ab5022a0))
* enhance logging functionality with ChatResponseCitations support ([ec87e3a](https://github.com/ax-llm/ax/commit/ec87e3a5af7e17293ccd0528c57220d464ca5c73))
## [14.0.14](https://github.com/ax-llm/ax/compare/14.0.13...14.0.14) (2025-08-12)

### Features

* add comprehensive API and Quick Start documentation ([4fbbf45](https://github.com/ax-llm/ax/commit/4fbbf452c5e0736ceb5a598d2d46a97c36eee7f1))
