/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import {
	AIArchitectureReport,
	AICapabilityCatalogueEntry,
	AIDisciplineId,
	AIFailureDiagnosisReport,
	AIPerformanceCostEstimate,
	AIResearchBrief,
	AISecurityAuditReport,
	AISecurityFinding,
	AIWorkflowDefinition,
	AIWorkflowStep,
	ComputeHardwareProfile,
	EngineRoutingDecision,
	EngineeringEngineMode,
	OneCommandFactoryBlueprint,
	ProductFactoryPhaseSpec,
	RagDocumentChunk,
	RagRetrievedChunk,
	TrainingStrategyRecommendation,
	UnifiedArchitectureOption,
} from './aiEngineeringTypes.js';

export interface WorkspaceCodeFile {
	readonly path: string;
	readonly content: string;
}

// ============================================================================
// 1. PERMANENT AI DISCIPLINE BLUEPRINTS & FUTURE CAPABILITY CATALOGUE
// ============================================================================

interface DisciplineMeta {
	readonly id: AIDisciplineId;
	readonly label: string;
	readonly keywords: readonly string[];
	readonly primarySpecialists: readonly string[];
	readonly defaultStack: readonly string[];
	readonly keyMetrics: readonly string[];
}

export const AI_DISCIPLINES: readonly DisciplineMeta[] = [
	{
		id: 'rag_knowledge',
		label: 'RAG & Knowledge Engineering',
		keywords: ['rag', 'retrieval', 'vector database', 'vector db', 'embeddings', 'knowledge base', 'semantic search', 'document qa', 'pdf qa', 'citations', 'rerank', 'graph rag', 'hybrid search'],
		primarySpecialists: ['rag_engineer', 'data_engineer', 'llm_engineer', 'ai_eval'],
		defaultStack: ['Python/FastAPI or TypeScript', 'Hybrid BM25 + Vector Store (pgvector/Qdrant/SQLite-vec)', 'Embedding + Reranker Adapter'],
		keyMetrics: ['Recall@K', 'Precision@K', 'MRR', 'Groundedness / Faithfulness', 'Citation Accuracy', 'Retrieval Latency p95'],
	},
	{
		id: 'conversational_ai',
		label: 'Chatbots, Copilots & Conversational AI',
		keywords: ['chatbot', 'copilot', 'conversational ai', 'customer support ai', 'ai assistant', 'chat assistant', 'virtual assistant', 'support bot', 'tutor bot', 'escalation'],
		primarySpecialists: ['llm_engineer', 'frontend', 'backend', 'ai_eval'],
		defaultStack: ['TypeScript/React Streaming Chat UI', 'Node/FastAPI Session Backend', 'PostgreSQL/SQLite Persistence', 'OpenAI-compatible Provider Abstraction'],
		keyMetrics: ['Resolution Rate', 'First-Token Latency (TTFT)', 'Escalation Accuracy', 'Hallucination Rate', 'CSAT'],
	},
	{
		id: 'agentic_ai',
		label: 'Agentic AI & Autonomous Multi-Agent Systems',
		keywords: ['ai agent', 'autonomous agent', 'multi-agent', 'agentic', 'agent workflow', 'tool calling', 'agent swarm', 'mcp agent', 'browser agent', 'computer use', 'langgraph', 'crewai', 'autogen'],
		primarySpecialists: ['agentic_engineer', 'ai_architect', 'ai_security', 'ai_eval'],
		defaultStack: ['TypeScript or Python Agent Runtime', 'Typed Tool Registry + Permission Guard', 'Durable Checkpoint Store', 'Structured Tracing'],
		keyMetrics: ['Task Completion Rate', 'Tool Call Accuracy', 'Recovery Rate', 'Step Efficiency', 'Token Cost / Task'],
	},
	{
		id: 'llm_foundation',
		label: 'LLM & Foundation Model Engineering',
		keywords: ['llm', 'large language model', 'foundation model', 'fine-tune', 'fine-tuning', 'lora', 'qlora', 'vllm', 'ollama', 'llama.cpp', 'quantization', 'distillation', 'prompt engineering', 'structured output', 'slm', 'embedding model'],
		primarySpecialists: ['llm_engineer', 'mlops', 'ai_eval'],
		defaultStack: ['PyTorch + Hugging Face Transformers + PEFT', 'vLLM / Ollama / llama.cpp Serving', 'OpenAI-compatible Gateway'],
		keyMetrics: ['Exact Match / Rubric Score', 'JSON Schema Validity', 'Tokens/sec Throughput', 'TTFT', 'Cost per 1M Tokens'],
	},
	{
		id: 'machine_learning',
		label: 'Machine Learning Engineering',
		keywords: ['machine learning', 'ml model', 'scikit-learn', 'xgboost', 'lightgbm', 'catboost', 'classification', 'regression', 'clustering', 'forecasting', 'anomaly detection', 'recommendation system', 'recommender', 'fraud detection', 'churn prediction', 'feature store', 'automl', 'drift detection'],
		primarySpecialists: ['ml_engineer', 'data_engineer', 'mlops', 'ai_eval'],
		defaultStack: ['Python + scikit-learn / XGBoost / LightGBM', 'Pandas/Polars Data Pipeline', 'ONNX Runtime / FastAPI', 'MLflow Experiment Tracking'],
		keyMetrics: ['F1 / ROC-AUC / PR-AUC', 'RMSE / MAE / R²', 'Calibration (ECE)', 'Feature Drift (PSI)'],
	},
	{
		id: 'deep_learning',
		label: 'Deep Learning Engineering',
		keywords: ['deep learning', 'neural network', 'pytorch', 'tensorflow', 'keras', 'jax', 'transformer', 'cnn', 'rnn', 'lstm', 'gnn', 'graph neural', 'diffusion', 'autoencoder', 'vae', 'gan', 'state-space', 'mamba', 'cuda', 'multi-gpu'],
		primarySpecialists: ['ml_engineer', 'ai_research', 'mlops'],
		defaultStack: ['Python + PyTorch (BF16/AMP) / JAX', 'TorchCompile / ONNX / TensorRT', 'Checkpointed Training Loop'],
		keyMetrics: ['Validation Loss', 'Generalization Accuracy', 'Throughput (samples/sec)', 'Peak VRAM', 'Inference p95'],
	},
	{
		id: 'computer_vision',
		label: 'Computer Vision & Visual Intelligence',
		keywords: ['computer vision', 'object detection', 'image classification', 'segmentation', 'yolo', 'opencv', 'ocr', 'document understanding', 'pose estimation', 'video analysis', 'visual search', 'depth estimation', 'slam', 'defect inspection', 'medical imaging', 'satellite imagery'],
		primarySpecialists: ['cv_engineer', 'ml_engineer', 'mlops'],
		defaultStack: ['Python + PyTorch + OpenCV / Ultralytics / ONNX Runtime', 'FastAPI Vision Inference Service', 'Web/Canvas Visualization UI'],
		keyMetrics: ['mAP@0.5 / mAP@0.5:0.95', 'IoU / Dice', 'OCR CER/WER', 'FPS / Frame Latency'],
	},
	{
		id: 'speech_audio',
		label: 'Speech, Audio & Multimodal AI',
		keywords: ['speech', 'voice assistant', 'asr', 'speech-to-text', 'text-to-speech', 'tts', 'whisper', 'audio transcription', 'diarization', 'sound event', 'noise reduction', 'music generation', 'multimodal'],
		primarySpecialists: ['speech_audio', 'llm_engineer', 'frontend'],
		defaultStack: ['Python + Whisper/ONNX Audio Pipeline', 'WebRTC / WebSocket Streaming', 'TypeScript Audio Capture UI'],
		keyMetrics: ['WER (Word Error Rate)', 'RTF (Real-Time Factor)', 'End-to-End Voice Latency', 'MOS Quality'],
	},
	{
		id: 'generative_ai',
		label: 'Generative AI Engineering',
		keywords: ['generative ai', 'image generation', 'video generation', '3d generation', 'synthetic data', 'creative ai', 'stable diffusion', 'flux', 'content generation'],
		primarySpecialists: ['ml_engineer', 'llm_engineer', 'ai_security'],
		defaultStack: ['Diffusers / PyTorch / Hosted Multimodal APIs', 'Async Job Queue + Object Storage', 'Safety & Watermark Guardrails'],
		keyMetrics: ['CLIP / Aesthetic Alignment', 'FID / Quality Rubric', 'Generation Latency', 'Safety Pass Rate'],
	},
	{
		id: 'ai_automation',
		label: 'AI Automation & Intelligent Workflows',
		keywords: ['ai automation', 'intelligent workflow', 'document processing', 'idp', 'rpa', 'data extraction', 'approval workflow', 'human-in-the-loop', 'report automation', 'email automation'],
		primarySpecialists: ['agentic_engineer', 'backend', 'ai_security'],
		defaultStack: ['Event/Cron Workflow Orchestrator', 'Durable Step Checkpointing', 'Structured Extraction + HITL Approval UI'],
		keyMetrics: ['Workflow Success Rate', 'Extraction Field F1', 'Mean Recovery Time', 'Human Escalation Rate'],
	},
	{
		id: 'iot_robotics_embodied',
		label: 'AI for IoT, Robotics & Embodied Intelligence',
		keywords: ['robotics', 'robot', 'iot ai', 'edge ai', 'tinyml', 'jetson', 'esp32', 'raspberry pi', 'predictive maintenance', 'sensor fusion', 'ros', 'ros2', 'drone', 'autonomous vehicle', 'mqtt', 'opc ua', 'modbus', 'digital twin', 'embodied'],
		primarySpecialists: ['robotics_iot', 'cv_engineer', 'mlops'],
		defaultStack: ['C++/Rust/Python Edge Runtime', 'ONNX Runtime / TensorRT / TFLite Micro', 'MQTT/OPC-UA Telemetry + Simulator Harness'],
		keyMetrics: ['Edge Inference Latency (ms)', 'Model Footprint (MB)', 'Sensor Anomaly F1', 'Sim-to-Real Safety Violations'],
	},
	{
		id: 'ai_research',
		label: 'AI Research, Reasoning & Simulation',
		keywords: ['ai research', 'symbolic ai', 'neuro-symbolic', 'bayesian', 'probabilistic', 'evolutionary', 'genetic algorithm', 'swarm intelligence', 'constraint solver', 'reinforcement learning', 'rl', 'world model', 'cognitive architecture', 'benchmark study', 'reproducible experiment'],
		primarySpecialists: ['ai_research', 'ml_engineer', 'ai_eval'],
		defaultStack: ['Python + PyTorch/JAX + NumPy/SciPy', 'Seeded Reproducible Experiment Runner', 'Automated Metric/Ablation Reporting'],
		keyMetrics: ['Reward / Objective Convergence', 'Ablation Delta', 'Statistical Significance (p-value / CI)', 'Reproducibility Seed Match'],
	},
];

export const AI_CAPABILITY_CATALOGUE: readonly AICapabilityCatalogueEntry[] = [
	{
		id: 'hybrid-rag-citations',
		name: 'Hybrid BM25 + Vector RAG with Grounded Citations',
		category: 'discipline',
		maturity: 'production',
		summary: 'Combines lexical BM25 precision with semantic vector recall, reciprocal rank fusion, and line-level source citations.',
		whyItMatters: 'Eliminates pure-vector exact-match blind spots (SKUs, code symbols, error codes) while preserving conceptual search.',
		dependencies: ['Local filesystem / pgvector / Qdrant (optional)'],
		compatibility: 'Works locally zero-dependency in Kodia AI Engine and scales to external vector DBs.',
		securityImplications: 'Enforce per-tenant metadata filters before retrieval and treat retrieved chunks as untrusted data against indirect prompt injection.',
		integrationStatus: 'built-in',
		knownLimitations: 'Local zero-dependency engine uses lexical+n-gram vectors; connect neural embedding provider for cross-lingual dense recall.',
	},
	{
		id: 'peft-qlora-adaptation',
		name: 'PEFT / LoRA & QLoRA Parameter-Efficient Fine-Tuning',
		category: 'framework',
		maturity: 'production',
		summary: 'Adapts open-weight LLMs/VLMs on single-GPU hardware via 4-bit NF4 quantization and low-rank adapters.',
		whyItMatters: 'Reduces fine-tuning VRAM requirements by 4–8x compared to full-parameter training while preserving base capabilities.',
		dependencies: ['Python', 'PyTorch', 'transformers', 'peft', 'bitsandbytes (CUDA)'],
		compatibility: 'Requires NVIDIA CUDA GPU for bitsandbytes QLoRA, or Apple Silicon MLX (`mlx-lm`) for unified memory LoRA.',
		securityImplications: 'Audit training corpora for PII, licensing compliance, and poisoned samples before training.',
		integrationStatus: 'adapter-ready',
		knownLimitations: 'Not viable on CPU-only laptops for >3B models without cloud GPU offload.',
	},
	{
		id: 'onnx-quantized-edge',
		name: 'ONNX Runtime & INT8/INT4 Edge Inference',
		category: 'infrastructure',
		maturity: 'production',
		summary: 'Exports PyTorch/scikit-learn/CV models to portable ONNX graphs with quantization for CPU, Jetson, mobile, and Rust/C++ runtimes.',
		whyItMatters: 'Decouples production serving from heavy Python training environments and cuts inference latency 2–5x.',
		dependencies: ['onnx', 'onnxruntime'],
		compatibility: 'Cross-language (Python, C++, Rust, C#, Node.js, Android, iOS).',
		securityImplications: 'Safer than Python pickle deserialization; still verify artifact SHA-256 integrity.',
		integrationStatus: 'adapter-ready',
		knownLimitations: 'Custom dynamic PyTorch ops may require opset adjustments during export.',
	},
	{
		id: 'mcp-acp-agent-protocols',
		name: 'Model Context Protocol (MCP) & Agent Communication Protocols (ACP)',
		category: 'protocol',
		maturity: 'production',
		summary: 'Standardized typed tool discovery, resource exposure, and interoperable agent-to-agent execution contracts.',
		whyItMatters: 'Prevents vendor lock-in and lets Kodia agents connect safely to external databases, SaaS tools, and specialist runtimes.',
		dependencies: ['@modelcontextprotocol/sdk (already installed in Kodia)'],
		compatibility: 'Native first-class integration in Kodia.',
		securityImplications: 'Every external MCP tool must pass autonomy policy, input validation, and secret redaction.',
		integrationStatus: 'built-in',
		knownLimitations: 'Remote MCP servers require explicit user approval and credential configuration.',
	},
	{
		id: 'test-time-compute-reasoning',
		name: 'Test-Time Compute & Structured Verification Loops',
		category: 'model-family',
		maturity: 'production',
		summary: 'Combines reasoning models with deterministic verifiers (compilers, unit tests, RAG evaluators, visual QA) to boost reliability.',
		whyItMatters: 'Verifiable feedback loops consistently outperform single-pass generation on complex engineering tasks.',
		dependencies: ['Reasoning-capable BYOK/local model + deterministic verification harness'],
		compatibility: 'Model-agnostic across OpenAI, Anthropic, Gemini, DeepSeek, NVIDIA, Ollama, vLLM.',
		securityImplications: 'Bound iteration counts and token budgets to prevent runaway loops or cost spikes.',
		integrationStatus: 'built-in',
		knownLimitations: 'Higher latency and token spend; route selectively to complex planning/debugging/architecture tasks.',
	},
	{
		id: 'state-space-hybrid-models',
		name: 'State-Space Models (Mamba / Hybrid Attention-SSM)',
		category: 'emerging',
		maturity: 'emerging',
		summary: 'Linear-time sequence modeling architectures offering fast long-context inference and lower KV-cache memory.',
		whyItMatters: 'Enables million-token telemetry, genomics, audio, and log-stream modeling on modest hardware.',
		dependencies: ['PyTorch', 'CUDA kernels / mamba-ssm or hybrid HF checkpoints'],
		compatibility: 'Best evaluated in isolated Python GPU environments.',
		securityImplications: 'Verify third-party custom CUDA extensions before installation.',
		integrationStatus: 'isolated-evaluation',
		knownLimitations: 'Ecosystem tooling and quantization support remain less uniform than standard Transformers.',
	},
	{
		id: 'world-models-embodied-vla',
		name: 'World Models & Vision-Language-Action (VLA) Robotics',
		category: 'emerging',
		maturity: 'experimental',
		summary: 'Predictive environment simulators and multimodal action policies for embodied robotics and spatial planning.',
		whyItMatters: 'Bridges perception, simulation, and control for autonomous robotics, drones, and industrial digital twins.',
		dependencies: ['Simulation engine (MuJoCo/Isaac/PyBullet)', 'ROS2', 'GPU compute'],
		compatibility: 'Requires simulator-first validation before any physical actuator deployment.',
		securityImplications: 'Physical safety interlocks, emergency stops, and human oversight are mandatory.',
		integrationStatus: 'isolated-evaluation',
		knownLimitations: 'High compute cost and sim-to-real transfer gap; never claim physical verification without real hardware tests.',
	},
	{
		id: 'neuro-symbolic-verification',
		name: 'Neuro-Symbolic Reasoning & Constrained Decoding',
		category: 'emerging',
		maturity: 'emerging',
		summary: 'Pairs neural language models with formal constraint solvers, grammars, and deterministic verification engines.',
		whyItMatters: 'Guarantees structural validity and formal invariants in financial, scheduling, legal, and compiler workloads.',
		dependencies: ['JSON Schema / CFG constrained decoding or Z3/SAT solver'],
		compatibility: 'Compatible with vLLM, llama.cpp, OpenAI Structured Outputs, and Python/TS solvers.',
		securityImplications: 'Greatly reduces malformed output injection risks.',
		integrationStatus: 'adapter-ready',
		knownLimitations: 'Requires explicit domain constraints and schema engineering.',
	},
];

export function discoverAICapabilities(query?: string, category?: AICapabilityCatalogueEntry['category']): AICapabilityCatalogueEntry[] {
	const words = (query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
	return AI_CAPABILITY_CATALOGUE.filter(entry => {
		if (category && entry.category !== category) { return false; }
		if (words.length === 0) { return true; }
		const hay = `${entry.name} ${entry.summary} ${entry.whyItMatters} ${entry.category} ${entry.maturity} ${entry.dependencies.join(' ')}`.toLowerCase();
		return words.some(w => hay.includes(w));
	});
}

// ============================================================================
// 2. UNIFIED TWO-ENGINE ORCHESTRATOR (NEVER FORCES AI INTO ORDINARY APPS)
// ============================================================================

const SOFTWARE_DOMAIN_PATTERNS: readonly { domain: string; regex: RegExp; langHint: string }[] = [
	{ domain: 'Web Frontend & UI', regex: /\b(web|website|frontend|react|next\.?js|vue|svelte|dashboard|portal|storefront|landing page|ui)\b/i, langHint: 'TypeScript' },
	{ domain: 'Backend API & Services', regex: /\b(backend|api|rest|graphql|microservice|server|auth|authentication|billing|subscription|stripe|webhook)\b/i, langHint: 'TypeScript / Go / Python' },
	{ domain: 'Database & Persistence', regex: /\b(database|postgres|postgresql|sqlite|mysql|mongo|prisma|schema|migration|persistence)\b/i, langHint: 'SQL' },
	{ domain: 'Mobile Clients (iOS / Android)', regex: /\b(mobile|android|ios|kotlin|swift|react native|flutter)\b/i, langHint: 'TypeScript / Kotlin / Swift' },
	{ domain: 'Desktop Application', regex: /\b(desktop|electron|tauri|native app|ide|editor)\b/i, langHint: 'TypeScript / Rust' },
	{ domain: 'Games & Simulation', regex: /\b(game|unity|godot|canvas|3d|rpg|strategy|physics)\b/i, langHint: 'TypeScript / C++ / C#' },
	{ domain: 'DevOps, Cloud & Deployment', regex: /\b(docker|kubernetes|k8s|ci\/cd|deploy|scalable|cloud|monitoring|terraform)\b/i, langHint: 'YAML / Docker' },
	{ domain: 'Systems / CLI / Embedded', regex: /\b(cli|library|sdk|compiler|calculator|utility|firmware|embedded|rust|c\+\+|go\b)\b/i, langHint: 'TypeScript / Go / Rust' },
];

function matchesKeywordBoundary(text: string, keyword: string): boolean {
	const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

export function routeEngineeringRequest(request: string): EngineRoutingDecision {
	const matchedDisciplines: { id: AIDisciplineId; score: number }[] = [];

	for (const d of AI_DISCIPLINES) {
		let score = 0;
		for (const kw of d.keywords) {
			if (matchesKeywordBoundary(request, kw)) {
				score += kw.includes(' ') ? 3 : 2;
			}
		}
		if (score > 0) {
			matchedDisciplines.push({ id: d.id, score });
		}
	}
	matchedDisciplines.sort((a, b) => b.score - a.score);
	const detectedDisciplines = matchedDisciplines.map(m => m.id);

	// Explicit generic AI signals even if a specific discipline keyword wasn't listed
	const hasExplicitAI = detectedDisciplines.length > 0
		|| /\b(artificial intelligence|ai[- ]powered|ai system|ai platform|ai engine|train a model|neural|inference service|model registry|mlops|llmops)\b/i.test(request);

	const softwareDomains: string[] = [];
	const langSet = new Set<string>();
	for (const p of SOFTWARE_DOMAIN_PATTERNS) {
		if (p.regex.test(request)) {
			softwareDomains.push(p.domain);
			for (const l of p.langHint.split('/').map(x => x.trim())) { langSet.add(l); }
		}
	}

	// Explicit language mentions override/enrich defaults
	if (/\bpython\b|\bfastapi\b|\bpytorch\b|\bscikit/i.test(request)) { langSet.add('Python'); }
	if (/\btypescript\b|\breact\b|\bnext\.?js\b|\bnode\b/i.test(request)) { langSet.add('TypeScript'); }
	if (/\bgo\b|\bgolang\b/i.test(request)) { langSet.add('Go'); }
	if (/\brust\b/i.test(request)) { langSet.add('Rust'); }
	if (/\bc\+\+\b|\bcuda\b/i.test(request)) { langSet.add('C++'); }
	if (/\bkotlin\b/i.test(request)) { langSet.add('Kotlin'); }
	if (/\bswift\b/i.test(request)) { langSet.add('Swift'); }

	if (hasExplicitAI && langSet.size === 0) {
		langSet.add('Python');
		langSet.add('TypeScript');
	} else if (langSet.size === 0) {
		langSet.add('TypeScript');
	}

	let engineMode: EngineeringEngineMode;
	if (!hasExplicitAI) {
		engineMode = 'universal_only';
	} else if (softwareDomains.length > 0 || /\b(platform|product|app|application|portal|saas|store|dashboard|full[- ]stack)\b/i.test(request)) {
		engineMode = 'dual_engine_unified';
	} else {
		engineMode = 'ai_only';
	}

	const specialists = new Set<string>(['architect']);
	if (engineMode === 'universal_only' || engineMode === 'dual_engine_unified') {
		if (softwareDomains.some(d => d.includes('Frontend') || d.includes('Mobile'))) { specialists.add('frontend'); specialists.add('ui_ux'); }
		if (softwareDomains.some(d => d.includes('Backend') || d.includes('Database'))) { specialists.add('backend'); specialists.add('database'); }
		if (softwareDomains.some(d => d.includes('DevOps'))) { specialists.add('devops'); }
		specialists.add('testing');
	}
	if (hasExplicitAI) {
		specialists.add('ai_architect');
		for (const id of detectedDisciplines.slice(0, 3)) {
			const meta = AI_DISCIPLINES.find(d => d.id === id);
			if (meta) {
				for (const s of meta.primarySpecialists) { specialists.add(s); }
			}
		}
		specialists.add('ai_eval');
		specialists.add('ai_security');
	}

	// High-impact domain governance flags (§21)
	const highImpactDomainFlags: string[] = [];
	if (/\b(medical|clinical|health|patient|diagnosis|hipaa)\b/i.test(request)) {
		highImpactDomainFlags.push('Healthcare/Medical domain: requires clinical validation, HIPAA/privacy controls, and qualified human oversight — never represent as clinically validated.');
	}
	if (/\b(bank|financial|trading|credit|loan|investment|fintech)\b/i.test(request)) {
		highImpactDomainFlags.push('Financial domain: requires auditability, deterministic numerical verification, regulatory review, and human approval for money movement.');
	}
	if (/\b(facial recognition|biometric|surveillance|hiring|employment|legal advice)\b/i.test(request)) {
		highImpactDomainFlags.push('Regulated/High-impact decision domain: requires lawful use verification, fairness auditing, explicit consent, and human-in-the-loop oversight.');
	}

	const rationale = engineMode === 'universal_only'
		? 'No AI/ML requirements detected. Routing exclusively to Kodia Universal Software Engineering Engine without injecting unnecessary AI complexity.'
		: engineMode === 'ai_only'
			? `Pure AI engineering request spanning [${detectedDisciplines.join(', ') || 'llm_foundation'}]. Routing to Kodia AI Engineering Engine with reproducible data, model, evaluation, and security workflows.`
			: `Full-stack AI product requiring coordinated Dual-Engine execution: Universal Software Engine owns [${softwareDomains.join(', ') || 'application shell & persistence'}], while AI Engineering Engine owns [${detectedDisciplines.join(', ') || 'AI services & evaluation'}].`;

	return {
		engineMode,
		requiresAI: hasExplicitAI,
		confidence: hasExplicitAI ? Math.min(0.98, 0.72 + detectedDisciplines.length * 0.08) : 0.92,
		detectedDisciplines,
		softwareDomains: softwareDomains.length > 0 ? softwareDomains : (hasExplicitAI ? [] : ['General Software Application']),
		recommendedLanguages: [...langSet],
		recommendedSpecialists: [...specialists],
		rationale,
		highImpactDomainFlags,
	};
}

// ============================================================================
// 3. AI ARCHITECTURE INTELLIGENCE & ONE-COMMAND AI PRODUCT FACTORY
// ============================================================================

export function designAIArchitecture(opts: {
	projectTitle: string;
	requirements: string;
	hardware?: ComputeHardwareProfile | null;
	computePreference?: 'auto' | 'local-first' | 'hybrid' | 'cloud-first';
}): AIArchitectureReport {
	const routing = routeEngineeringRequest(opts.requirements);
	const disciplines: readonly AIDisciplineId[] = routing.detectedDisciplines.length > 0
		? routing.detectedDisciplines
		: ['llm_foundation'];
	const hasRag = disciplines.includes('rag_knowledge');
	const hasVision = disciplines.includes('computer_vision');
	const hasAgents = disciplines.includes('agentic_ai') || disciplines.includes('ai_automation');
	const hasMl = disciplines.includes('machine_learning') || disciplines.includes('deep_learning');
	const hasLocalGpu = !!(opts.hardware && (opts.hardware.hasCuda || opts.hardware.hasAppleSilicon));

	const recommendedStack: string[] = [];
	if (routing.engineMode === 'dual_engine_unified') {
		recommendedStack.push('TypeScript + React Frontend (with Design Intelligence tokens)');
		recommendedStack.push(routing.recommendedLanguages.includes('Go') ? 'Go Core API Gateway' : 'Node/TypeScript or FastAPI Application Backend');
		recommendedStack.push('PostgreSQL / SQLite Relational Store');
	}
	if (hasRag) { recommendedStack.push('Hybrid BM25 + Vector Retrieval Engine (pgvector / Qdrant / Kodia Local RAG)'); }
	if (hasVision) { recommendedStack.push('Python + PyTorch / ONNX Runtime Vision Inference Service'); }
	if (hasMl) { recommendedStack.push('Python + scikit-learn/PyTorch Training & MLflow Experiment Pipeline'); }
	if (hasAgents) { recommendedStack.push('Typed Tool-Calling Agent Runtime with Durable Checkpoints & Permission Guard'); }
	recommendedStack.push(
		opts.computePreference === 'local-first' || (hasLocalGpu && opts.computePreference !== 'cloud-first')
			? 'Model-Agnostic Provider Gateway (Ollama/vLLM Local + BYOK Cloud Fallback)'
			: 'Model-Agnostic BYOK Provider Gateway (OpenAI/Anthropic/Gemini/NVIDIA + Local Ollama Fallback)',
	);

	const recommendedArchitecture: UnifiedArchitectureOption = {
		name: routing.engineMode === 'dual_engine_unified'
			? 'Modular Dual-Engine Mixed-Stack Architecture'
			: 'Modular Reproducible AI Service Architecture',
		summary: 'Clean separation between application domain services, model-agnostic AI orchestration, retrieval/data pipelines, and quantitative evaluation harnesses.',
		stack: recommendedStack,
		strengths: [
			'Zero vendor lock-in via provider-agnostic adapter + capability-aware routing.',
			'Independent scaling and testing of application logic vs AI inference pipelines.',
			'Built-in observability, prompt-injection defense, and automated regression evaluations.',
		],
		tradeoffs: [
			'Requires explicit typed API contracts between application backend and AI microservices.',
			'Adds container/service orchestration overhead compared to a single monolithic script.',
		],
		estimatedMonthlyCostUsd: opts.computePreference === 'local-first' ? '\$0–\$50 (local hardware + optional burst API)' : '\$40–\$350 (scales with token volume & caching)',
		estimatedLatencyMs: hasRag ? '350–1,400ms (hybrid retrieval + streaming TTFT)' : hasVision ? '25–120ms/frame (ONNX/GPU)' : '250–900ms TTFT (streaming)',
		recommended: true,
	};

	const alternatives: UnifiedArchitectureOption[] = [
		{
			name: 'Single-Runtime Lightweight Architecture',
			summary: 'Embeds AI provider calls and SQLite-backed hybrid retrieval directly inside one TypeScript or Python service.',
			stack: ['Single TypeScript/Node or Python/FastAPI service', 'SQLite + Local Hybrid RAG', 'BYOK Provider Adapter'],
			strengths: ['Minimal operational overhead', 'Fastest local development and single-container deployment'],
			tradeoffs: ['Less suited for GPU-heavy PyTorch/CV training or high-concurrency independent scaling'],
			estimatedMonthlyCostUsd: '\$15–\$120',
			estimatedLatencyMs: '200–800ms TTFT',
			recommended: false,
		},
		{
			name: 'Dedicated GPU Self-Hosted Cluster',
			summary: 'Hosts open-weight models on vLLM/Triton Inference Server behind Kubernetes autoscaling for strict data residency.',
			stack: ['vLLM / Triton Inference Server', 'Kubernetes GPU Node Pool', 'Private Vector DB + MinIO Artifact Store'],
			strengths: ['Full data residency', 'Predictable high-throughput unit economics at scale'],
			tradeoffs: ['Higher fixed GPU infrastructure cost and DevOps maintenance'],
			estimatedMonthlyCostUsd: '\$600–\$3,500+ (dedicated GPU instances)',
			estimatedLatencyMs: '120–450ms TTFT',
			recommended: false,
		},
	];

	const mermaidDiagram = [
		'flowchart LR',
		'  User["User / Client (Web / Mobile / API)"] --> App["Universal App Engine (UI + Auth + Core API)"]',
		'  App --> Orch["Unified AI Orchestrator & Guardrails"]',
		...(hasRag ? ['  Orch --> RAG["Hybrid RAG & Knowledge Index (Citations + ACL)"]'] : []),
		...(hasAgents ? ['  Orch --> Agents["Agent Runtime (Typed Tools + Checkpoints)"]'] : []),
		...(hasVision ? ['  Orch --> CV["Computer Vision / ONNX Inference Service"]'] : []),
		...(hasMl ? ['  Orch --> ML["ML Pipeline + Model Registry"]'] : []),
		'  Orch --> Gateway["Model-Agnostic Gateway (BYOK Cloud / Local Ollama / vLLM)"]',
		'  Orch --> Eval["Evaluation, Tracing & Cost Observability"]',
	].join('\n');

	return {
		projectTitle: opts.projectTitle,
		engineMode: routing.engineMode,
		disciplines,
		recommendedArchitecture,
		alternatives,
		dataFlows: [
			'Ingest raw data/documents -> schema & PII validation -> versioned storage/chunking -> lineage fingerprint.',
			'Every prediction, retrieval, and agent action logs structured latency, token usage, and redacted traces.',
		],
		inferenceFlows: [
			'Client request -> input validation & prompt-injection screening -> capability-routed model/pipeline call -> schema/output validation -> streamed response with citations.',
		],
		evaluationStrategy: [
			'Golden evaluation dataset stored in workspace with automated CI regression threshold gates.',
			...disciplines.slice(0, 3).map(id => {
				const m = AI_DISCIPLINES.find(d => d.id === id);
				return m ? `${m.label}: track ${m.keyMetrics.join(', ')}.` : id;
			}),
		],
		securityControls: [
			'BYOK secrets strictly in environment/vault — never committed to code or logged.',
			'Strict separation of system instructions vs untrusted retrieved documents/user inputs.',
			'Least-privilege tool permissions, tenant-scoped retrieval filters, and output schema validation.',
			...routing.highImpactDomainFlags,
		],
		technicalRisks: [
			{ risk: 'Hallucinations or ungrounded responses', mitigation: 'Require hybrid retrieval + source citation verification + automated groundedness evals.' },
			{ risk: 'Provider rate limits (429) or latency spikes', mitigation: 'Implement semantic/prompt caching, streaming responses, and automatic BYOK fallback routing.' },
			{ risk: 'Prompt injection or unsafe tool invocation', mitigation: 'Enforce typed parameter schemas, permission boundaries, and HITL gates on destructive/paid actions.' },
		],
		mermaidDiagram,
	};
}

export function generateOneCommandFactoryBlueprint(opts: {
	objective: string;
	projectTitle?: string;
	hardware?: ComputeHardwareProfile | null;
	computePreference?: 'auto' | 'local-first' | 'hybrid' | 'cloud-first';
}): OneCommandFactoryBlueprint {
	const title = opts.projectTitle?.trim() || opts.objective.trim().slice(0, 56);
	const routing = routeEngineeringRequest(opts.objective);
	const architecture = designAIArchitecture({
		projectTitle: title,
		requirements: opts.objective,
		hardware: opts.hardware,
		computePreference: opts.computePreference,
	});

	const phases: ProductFactoryPhaseSpec[] = [
		{
			phaseNumber: 1,
			name: 'Understand & Scope',
			ownerEngine: 'unified',
			specialists: ['planner', 'architect', ...(routing.requiresAI ? ['ai_architect'] : [])],
			deliverables: ['Functional & non-functional requirements (REQ-xxx)', 'AI suitability & engine routing decision', 'Security, privacy & high-impact governance boundaries'],
			verificationGate: 'Requirements registered and assumptions explicitly documented.',
		},
		{
			phaseNumber: 2,
			name: 'Research & Architecture',
			ownerEngine: 'unified',
			specialists: ['architect', ...(routing.requiresAI ? ['ai_architect', 'ai_research'] : [])],
			deliverables: ['System & AI architecture ADR with trade-offs', 'Shared API, DB, Model & Dataset contracts', 'Hardware & cost estimate'],
			verificationGate: 'Workspace inspected, hardware probed, and ADR recorded.',
		},
		{
			phaseNumber: 3,
			name: 'Project Foundation & Schemas',
			ownerEngine: 'universal',
			specialists: ['backend', 'database', 'frontend'],
			deliverables: ['Clean directory layout & manifests', 'Database schemas & migrations', 'Typed API & shared contract definitions', 'Design tokens & responsive shell'],
			verificationGate: 'Project installs/compiles cleanly with zero schema errors.',
		},
		{
			phaseNumber: 4,
			name: 'Core Software Implementation',
			ownerEngine: 'universal',
			specialists: ['frontend', 'backend', 'ui_ux'],
			deliverables: ['Real frontend UI connected to real backend APIs', 'Auth, persistence, business workflows & error handling'],
			verificationGate: 'Core non-AI software journeys compile and pass unit tests.',
		},
		...(routing.requiresAI ? [{
			phaseNumber: 5,
			name: 'AI Subsystem Engineering',
			ownerEngine: 'ai' as const,
			specialists: routing.recommendedSpecialists.filter(s => s.startsWith('ai_') || s.includes('_engineer') || s === 'mlops' || s === 'speech_audio' || s === 'robotics_iot'),
			deliverables: ['Provider-agnostic model adapter', 'RAG / ML / CV / Agent / Workflow pipelines', 'Dataset profiling, experiment records & model registry entries'],
			verificationGate: 'AI pipeline executes end-to-end with verified artifacts and metrics.',
		}] : []),
		{
			phaseNumber: routing.requiresAI ? 6 : 5,
			name: 'Full Cross-Engine Integration',
			ownerEngine: 'unified',
			specialists: ['backend', 'frontend', ...(routing.requiresAI ? ['llm_engineer'] : [])],
			deliverables: ['End-to-end wiring between UI, API, DB, and AI services', 'Streaming, retries, fallbacks & tenant isolation'],
			verificationGate: 'Live integration tests prove real data flows across all layers.',
		},
		{
			phaseNumber: routing.requiresAI ? 7 : 6,
			name: 'Verification, Evaluation & Auto-Repair',
			ownerEngine: 'unified',
			specialists: ['testing', 'browser', 'security', ...(routing.requiresAI ? ['ai_eval', 'ai_security'] : [])],
			deliverables: ['Unit, integration & browser visual QA tests', ...(routing.requiresAI ? ['Quantitative AI/RAG/Agent evaluation scorecard', 'AI security & prompt-injection audit'] : ['Static security & quality gate audit'])],
			verificationGate: 'All tests pass, quality gates green, and Verification Ledger proof recorded.',
		},
		{
			phaseNumber: routing.requiresAI ? 8 : 7,
			name: 'Production Preparation',
			ownerEngine: 'unified',
			specialists: ['devops', ...(routing.requiresAI ? ['mlops'] : [])],
			deliverables: ['.env.example with redacted secrets guidance', 'Dockerfile / Compose / CI workflow', 'Monitoring, logging, backup & rollback runbook'],
			verificationGate: 'Production config syntax validated and zero hardcoded secrets.',
		},
		{
			phaseNumber: routing.requiresAI ? 9 : 8,
			name: 'Verified Delivery Report',
			ownerEngine: 'unified',
			specialists: ['docs'],
			deliverables: ['Exact summary of what was built & verified', 'Test & evaluation evidence', 'Explicit remaining limitations & external credentials required'],
			verificationGate: 'No unverified claims; all delivered artifacts confirmed on disk.',
		},
	];

	return {
		id: `aifactory-${Date.now().toString(36)}`,
		createdAt: new Date().toISOString(),
		objective: opts.objective,
		routing,
		architecture,
		sharedContracts: [
			'Requirements Contract: REQ-xxx tracked in Kodia SoftwareFactoryService',
			'API Contract: Typed request/response schemas + error codes shared by Frontend, Backend & AI services',
			'Data & Lineage Contract: Dataset SHA-256 fingerprints, schema profiles & tenant ACL metadata',
			'Model & Eval Contract: Provider-agnostic model adapter + golden evaluation benchmarks + Verification Ledger proof',
		],
		phases,
		productionReadinessChecklist: [
			'All external API keys injected strictly via environment variables (.env.example provided, .env gitignored)',
			'Automated tests + AI evaluation suite passing locally',
			'Health check endpoints (/health, /ready) and structured JSON logging configured',
			'Rate limiting, input/output validation, and prompt-injection defenses verified',
			'Deployment manifests (Docker/CI) and rollback documentation ready',
		],
		explicitAssumptions: [
			'Local development uses SQLite/local hybrid RAG by default unless PostgreSQL/pgvector credentials are already configured in .env.',
			'Model calls route through user-configured BYOK or local Ollama/vLLM endpoints without hardcoding a single vendor.',
		],
		missingExternalDependencies: [
			'External cloud credentials (OpenAI/Anthropic/Gemini/AWS/Stripe/etc.) must be supplied by the user via environment variables before live hosted calls.',
			'Production cloud/Kubernetes deployment requires explicit user authorization.',
		],
	};
}

// ============================================================================
// 4. TRAINING STRATEGY & COST/PERFORMANCE ESTIMATION
// ============================================================================

export function recommendTrainingStrategy(opts: {
	taskType: string;
	datasetRows: number;
	modelSizeBillions?: number;
	deploymentTarget?: string;
	hardware?: ComputeHardwareProfile | null;
}): TrainingStrategyRecommendation {
	const modelB = opts.modelSizeBillions ?? 7;
	const computeTier = opts.hardware?.recommendedComputeTier ?? 'cpu-only';
	const totalVramGb = (opts.hardware?.gpus ?? []).reduce((s, g) => s + ((g.vramMb ?? 0) / 1024), 0);
	const isTabularOrClassical = /tabular|classification|regression|forecast|anomaly|fraud|churn|recommend/i.test(opts.taskType) && !/llm|language|vision|image|audio/i.test(opts.taskType);

	if (isTabularOrClassical) {
		return {
			taskType: opts.taskType,
			modelSizeHint: 'Classical ML / GBDT (<50 MB)',
			datasetRows: opts.datasetRows,
			computeTier,
			recommendedApproach: 'classical-ml-cpu',
			precision: 'fp32',
			frameworkStack: ['scikit-learn', 'LightGBM / XGBoost / CatBoost', 'Optuna (HPO)', 'ONNX Runtime'],
			estimatedVramGb: 0,
			hyperparameters: { cv_folds: 5, early_stopping_rounds: 50, learning_rate: 0.05, max_depth: 6, random_seed: 42 },
			rationale: 'Gradient-boosted trees and regularized linear baselines consistently outperform deep neural networks on structured tabular datasets while training rapidly on CPU.',
			reproducibilityChecklist: ['Fix random_seed=42 across splits and estimators', 'Fit scalers/encoders strictly inside CV folds to prevent data leakage', 'Export winning model to ONNX + log metrics to Kodia Model Registry'],
		};
	}

	if (opts.datasetRows < 250 && /chat|qa|rag|extract|summari|agent/i.test(opts.taskType)) {
		return {
			taskType: opts.taskType,
			modelSizeHint: `${modelB}B LLM (adapted via RAG/prompting)`,
			datasetRows: opts.datasetRows,
			computeTier,
			recommendedApproach: 'prompt-engineering-and-rag',
			precision: 'bf16',
			frameworkStack: ['Kodia Hybrid RAG', 'Structured Outputs / Few-Shot Examples', 'Automated Eval Harness'],
			estimatedVramGb: 0,
			hyperparameters: { top_k: 5, temperature: 0.1, chunk_size: 800, chunk_overlap: 120 },
			rationale: `With ${opts.datasetRows} rows, prompt engineering + hybrid RAG delivers faster iteration, transparent citations, and zero fine-tuning overfitting risk.`,
			reproducibilityChecklist: ['Pin prompt template versions and model identifiers', 'Evaluate against a fixed golden Q&A set via ai_rag_evaluate'],
		};
	}

	const qloraVram = Math.max(6, Math.round(modelB * 0.9 + 3));
	const loraVram = Math.max(12, Math.round(modelB * 2.4 + 4));

	if (opts.deploymentTarget && /edge|mobile|jetson|rpi|esp32|cpu/i.test(opts.deploymentTarget)) {
		return {
			taskType: opts.taskType,
			modelSizeHint: `${Math.min(modelB, 3)}B Compact / Quantized Model`,
			datasetRows: opts.datasetRows,
			computeTier,
			recommendedApproach: 'distillation-and-quantization',
			precision: 'int8',
			frameworkStack: ['PyTorch + PEFT Distillation', 'ONNX Runtime / llama.cpp GGUF / TensorRT'],
			estimatedVramGb: Math.min(qloraVram, 12),
			hyperparameters: { lora_r: 16, lora_alpha: 32, learning_rate: 2e-4, epochs: 3, quant_bits: 4 },
			rationale: `Target deployment (${opts.deploymentTarget}) demands small footprint and low latency: distill into a compact architecture and export quantized ONNX/GGUF.`,
			reproducibilityChecklist: ['Benchmark accuracy drop before vs after quantization', 'Measure p95 latency and RAM on target runtime'],
		};
	}

	if (computeTier === 'multi-gpu' || totalVramGb >= loraVram) {
		return {
			taskType: opts.taskType,
			modelSizeHint: `${modelB}B Foundation Model`,
			datasetRows: opts.datasetRows,
			computeTier,
			recommendedApproach: 'lora-peft',
			precision: 'bf16',
			frameworkStack: ['PyTorch (BF16)', 'Hugging Face Transformers + PEFT + TRL', 'Kodia Experiment Tracker'],
			estimatedVramGb: loraVram,
			hyperparameters: { lora_r: 16, lora_alpha: 32, lora_dropout: 0.05, learning_rate: 1.5e-4, batch_size: 16, epochs: 3, warmup_ratio: 0.05 },
			rationale: `Detected sufficient GPU memory (${totalVramGb.toFixed(1)} GB VRAM) for BF16 LoRA adaptation with minimal accuracy loss and fast convergence.`,
			reproducibilityChecklist: ['Save checkpoints every epoch with validation loss early stopping', 'Log dataset SHA-256 and eval metrics in Kodia Model Registry'],
		};
	}

	if (totalVramGb >= qloraVram || computeTier === 'apple-silicon-unified') {
		return {
			taskType: opts.taskType,
			modelSizeHint: `${modelB}B Foundation Model`,
			datasetRows: opts.datasetRows,
			computeTier,
			recommendedApproach: 'qlora-peft',
			precision: 'nf4-qlora',
			frameworkStack: computeTier === 'apple-silicon-unified'
				? ['MLX (`mlx-lm`) LoRA', 'Apple Silicon Unified Memory']
				: ['PyTorch + PEFT + bitsandbytes (NF4 QLoRA)', 'Gradient Checkpointing'],
			estimatedVramGb: qloraVram,
			hyperparameters: { lora_r: 16, lora_alpha: 32, learning_rate: 2e-4, grad_accum_steps: 8, epochs: 3, max_seq_len: 2048 },
			rationale: 'QLoRA (4-bit NF4 base + BF16 adapters) fits cleanly within single-GPU / unified memory budgets while matching LoRA quality.',
			reproducibilityChecklist: ['Enable gradient checkpointing and paged AdamW', 'Verify adapter merge and run held-out evaluation before promotion'],
		};
	}

	return {
		taskType: opts.taskType,
		modelSizeHint: `${modelB}B Foundation Model`,
		datasetRows: opts.datasetRows,
		computeTier: 'cloud-offload',
		recommendedApproach: 'cloud-distributed-training',
		precision: 'nf4-qlora',
		frameworkStack: ['Reproducible Local Prep + Validation', 'Cloud GPU Job (QLoRA/FSDP — requires user cost approval)', 'vLLM / ONNX Serving'],
		estimatedVramGb: qloraVram,
		hyperparameters: { lora_r: 16, lora_alpha: 32, learning_rate: 2e-4, epochs: 3, batch_size: 32 },
		rationale: `Local hardware (${computeTier}, ${totalVramGb.toFixed(1)} GB VRAM) cannot train a ${modelB}B model locally within practical time; prepare & dry-run data pipeline locally, then request explicit user approval before provisioning cloud GPUs.`,
		reproducibilityChecklist: ['Run 10-sample CPU dry-run smoke test locally first', 'Require explicit budget/compute authorization before launching paid cloud training'],
	};
}

export function estimateAIPerformanceAndCost(opts: {
	workloadName: string;
	monthlyRequests: number;
	avgInputTokens?: number;
	avgOutputTokens?: number;
}): AIPerformanceCostEstimate {
	const reqs = Math.max(1, opts.monthlyRequests);
	const inTok = Math.max(10, opts.avgInputTokens ?? 1200);
	const outTok = Math.max(10, opts.avgOutputTokens ?? 400);
	const totalTokens = reqs * (inTok + outTok);
	const inM = (reqs * inTok) / 1_000_000;
	const outM = (reqs * outTok) / 1_000_000;

	const round2 = (n: number) => Math.round(n * 100) / 100;

	return {
		workloadName: opts.workloadName,
		monthlyRequests: reqs,
		avgInputTokens: inTok,
		avgOutputTokens: outTok,
		estimatedMonthlyTokens: totalTokens,
		tiers: [
			{
				tier: 'Local / Self-Hosted SLM (7B–14B Quantized)',
				modelClass: 'Ollama / vLLM / llama.cpp',
				estimatedLatencyP50Ms: 380,
				estimatedLatencyP95Ms: 1100,
				estimatedMonthlyCostUsd: 0,
				notes: 'Zero per-token API fees on existing local GPU/Apple Silicon; throughput bounded by local VRAM.',
			},
			{
				tier: 'Fast / Cost-Optimized Hosted Model',
				modelClass: 'Flash / Mini / Haiku tier (~\$0.25/M in, \$1.25/M out)',
				estimatedLatencyP50Ms: 420,
				estimatedLatencyP95Ms: 1250,
				estimatedMonthlyCostUsd: round2(inM * 0.25 + outM * 1.25),
				notes: 'Ideal default for classification, extraction, RAG synthesis, and high-volume chat.',
			},
			{
				tier: 'Frontier Reasoning / Flagship Hosted Model',
				modelClass: 'Opus / Pro / Flagship tier (~\$3.00/M in, \$15.00/M out)',
				estimatedLatencyP50Ms: 950,
				estimatedLatencyP95Ms: 2800,
				estimatedMonthlyCostUsd: round2(inM * 3.0 + outM * 15.0),
				notes: 'Reserve via capability routing for complex architecture, deep debugging, and high-stakes synthesis.',
			},
		],
		optimizations: [
			'Enable prompt caching on stable system prompts & static knowledge prefixes (up to 50–90% input token savings).',
			'Route simple classification/extraction/FAQ traffic to Fast/Local models and escalate only complex queries to Flagship models.',
			'Cache deterministic RAG queries and embeddings keyed by content hash.',
			'Stream responses to improve perceived Time-To-First-Token (TTFT) and enforce max_output_tokens ceilings.',
		],
	};
}

// ============================================================================
// 5. PURE HYBRID RAG CHUNKING, VECTORIZATION, RETRIEVAL & EVALUATION MATH
// ============================================================================

const STOP_WORDS = new Set([
	'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
	'not', 'but', 'you', 'your', 'can', 'will', 'all', 'any', 'into', 'our', 'out', 'use', 'using',
	'about', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'then', 'than', 'also', 'been',
]);

export function tokenizeForRag(text: string): string[] {
	const raw = text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
	const out: string[] = [];
	for (const tok of raw) {
		if (!STOP_WORDS.has(tok)) {
			out.push(tok);
		}
	}
	return out;
}

export function buildTermFreqMap(text: string): Record<string, number> {
	const tf: Record<string, number> = {};
	for (const tok of tokenizeForRag(text)) {
		tf[tok] = (tf[tok] ?? 0) + 1;
	}
	return tf;
}

/**
 * Splits a document into line-tracked, heading-aware overlapping chunks for accurate citations.
 */
export function chunkDocumentForRag(opts: {
	sourcePath: string;
	content: string;
	chunkSize?: number;
	chunkOverlap?: number;
	metadata?: Record<string, string>;
}): RagDocumentChunk[] {
	const chunkSize = Math.max(200, Math.min(4000, opts.chunkSize ?? 800));
	const overlap = Math.max(0, Math.min(Math.floor(chunkSize / 2), opts.chunkOverlap ?? 120));
	const lines = opts.content.split(/\r?\n/);
	const chunks: RagDocumentChunk[] = [];

	let currentSection: string | undefined;
	let bufLines: string[] = [];
	let bufChars = 0;
	let startLine = 1;
	let chunkIdx = 0;

	const flush = (endLine: number) => {
		const text = bufLines.join('\n').trim();
		if (!text) { return; }
		chunks.push({
			chunkId: `${opts.sourcePath}#c${++chunkIdx}`,
			sourcePath: opts.sourcePath,
			sectionTitle: currentSection,
			startLine,
			endLine,
			text,
			tokenEstimate: Math.ceil(text.length / 4),
			metadata: { source: opts.sourcePath, ...(currentSection ? { section: currentSection } : {}), ...(opts.metadata ?? {}) },
			termFreq: buildTermFreqMap(`${opts.sourcePath} ${currentSection ?? ''} ${text}`),
		});
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const headingMatch = /^#{1,4}\s+(.+)$/.exec(line.trim());
		if (headingMatch) {
			if (bufChars >= Math.floor(chunkSize * 0.35)) {
				flush(i);
				bufLines = [];
				bufChars = 0;
				startLine = i + 1;
			}
			currentSection = headingMatch[1].trim().slice(0, 100);
		}
		bufLines.push(line);
		bufChars += line.length + 1;

		if (bufChars >= chunkSize) {
			flush(i + 1);
			// Retain trailing overlap lines
			const overlapLines: string[] = [];
			let ovChars = 0;
			for (let j = bufLines.length - 1; j >= 0 && ovChars < overlap; j--) {
				overlapLines.unshift(bufLines[j]);
				ovChars += bufLines[j].length + 1;
			}
			bufLines = overlapLines;
			bufChars = ovChars;
			startLine = Math.max(1, (i + 1) - overlapLines.length + 1);
		}
	}
	if (bufLines.length > 0) {
		flush(lines.length);
	}
	return chunks;
}

function charTrigrams(text: string): Map<string, number> {
	const cleaned = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const map = new Map<string, number>();
	for (let i = 0; i <= cleaned.length - 3; i++) {
		const g = cleaned.slice(i, i + 3);
		map.set(g, (map.get(g) ?? 0) + 1);
	}
	return map;
}

function cosineMapSimilarity(a: Map<string, number>, b: Map<string, number>): number {
	if (a.size === 0 || b.size === 0) { return 0; }
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [, v] of a) { normA += v * v; }
	for (const [, v] of b) { normB += v * v; }
	for (const [k, va] of a) {
		const vb = b.get(k);
		if (vb !== undefined) { dot += va * vb; }
	}
	return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

/**
 * Hybrid BM25 + Character N-Gram Cosine Semantic Retrieval with Citation Formatting.
 */
export function searchRagChunksHybrid(
	chunks: readonly RagDocumentChunk[],
	query: string,
	opts?: { topK?: number; sourceFilter?: string },
): { expandedTerms: string[]; results: RagRetrievedChunk[]; groundedContextBlock: string } {
	const topK = Math.max(1, Math.min(20, opts?.topK ?? 5));
	const filtered = opts?.sourceFilter
		? chunks.filter(c => c.sourcePath.toLowerCase().includes(opts.sourceFilter!.toLowerCase()))
		: chunks;

	const queryTerms = [...new Set(tokenizeForRag(query))];
	const qTrigrams = charTrigrams(query);
	const N = Math.max(1, filtered.length);
	const avgLen = filtered.reduce((s, c) => s + Object.values(c.termFreq).reduce((a, b) => a + b, 0), 0) / N || 1;

	// Document frequency per query term
	const df = new Map<string, number>();
	for (const term of queryTerms) {
		let count = 0;
		for (const c of filtered) {
			if (c.termFreq[term]) { count++; }
		}
		df.set(term, count);
	}

	const k1 = 1.5;
	const b = 0.75;

	const scored = filtered.map(c => {
		const docLen = Object.values(c.termFreq).reduce((a, v) => a + v, 0) || 1;
		let bm25 = 0;
		for (const term of queryTerms) {
			const f = c.termFreq[term] ?? 0;
			if (f === 0) { continue; }
			const docFreq = df.get(term) ?? 0;
			const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
			bm25 += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgLen))));
		}
		const semantic = cosineMapSimilarity(qTrigrams, charTrigrams(`${c.sectionTitle ?? ''} ${c.text.slice(0, 600)}`));
		const normalizedBm25 = bm25 > 0 ? bm25 / (bm25 + 2.5) : 0;
		const hybrid = Math.round((normalizedBm25 * 0.68 + semantic * 0.32) * 10_000) / 10_000;
		return { chunk: c, hybrid, lexical: Math.round(normalizedBm25 * 1000) / 1000, semantic: Math.round(semantic * 1000) / 1000 };
	});

	scored.sort((a, b) => b.hybrid - a.hybrid);
	const top = scored.filter(s => s.hybrid > 0.01).slice(0, topK);

	const results: RagRetrievedChunk[] = top.map((item, idx) => ({
		rank: idx + 1,
		chunkId: item.chunk.chunkId,
		sourcePath: item.chunk.sourcePath,
		sectionTitle: item.chunk.sectionTitle,
		startLine: item.chunk.startLine,
		endLine: item.chunk.endLine,
		text: item.chunk.text,
		hybridScore: item.hybrid,
		lexicalScore: item.lexical,
		semanticScore: item.semantic,
		citation: `[${idx + 1}] ${item.chunk.sourcePath}:${item.chunk.startLine}-${item.chunk.endLine}${item.chunk.sectionTitle ? ` (${item.chunk.sectionTitle})` : ''}`,
	}));

	const groundedContextBlock = results.length === 0
		? 'No grounded matching context found in index.'
		: results.map(r => `${r.citation} (score=${r.hybridScore})\n${r.text}`).join('\n\n---\n\n');

	return { expandedTerms: queryTerms, results, groundedContextBlock };
}

// ============================================================================
// 6. AI SECURITY, PROMPT INJECTION & GOVERNANCE STATIC AUDITOR
// ============================================================================

export function auditAISecurityWorkspace(files: readonly WorkspaceCodeFile[]): AISecurityAuditReport {
	const findings: AISecurityFinding[] = [];
	const protections = new Set<string>();
	const highImpactNotices = new Set<string>();

	const add = (f: Omit<AISecurityFinding, 'id'>) => {
		findings.push({ id: `AISEC-${String(findings.length + 1).padStart(3, '0')}`, ...f });
	};

	const codeFiles = files.filter(f => /\.(ts|tsx|js|jsx|py|go|rs|java|cs|yaml|yml|json|env)$/i.test(f.path));

	for (const f of codeFiles) {
		const lines = f.content.split(/\r?\n/);
		const full = f.content;

		if (/zod|pydantic|ajv|jsonschema|validate/i.test(full)) { protections.add('Schema validation detected'); }
		if (/redact|sanitize|escape|allowlist|whitelist/i.test(full)) { protections.add('Input/output sanitization or allowlisting detected'); }
		if (/rate.?limit|throttle|backoff|retry/i.test(full)) { protections.add('Rate limiting or retry protection detected'); }
		if (/tenant_id|organization_id|workspace_id|user_id/i.test(full)) { protections.add('Tenant/user scoping identifiers present'); }

		if (/\b(hipaa|patient|clinical|diagnosis|medical_record)\b/i.test(full)) {
			highImpactNotices.add(`Healthcare/clinical markers detected in ${f.path}: ensure privacy compliance and qualified clinician oversight.`);
		}
		if (/\b(wire_transfer|credit_score|loan_approval|trading_order)\b/i.test(full)) {
			highImpactNotices.add(`Financial decision markers detected in ${f.path}: enforce deterministic audit trail and human approval.`);
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// 1. Unsafe Python pickle / torch.load without weights_only=True
			if (/\bpickle\.loads?\s*\(|\byaml\.load\s*\([^)]*\)(?!.*SafeLoader)/i.test(line)) {
				add({
					severity: 'critical',
					category: 'unsafe-deserialization',
					title: 'Unsafe model/data deserialization (arbitrary code execution risk)',
					file: f.path,
					line: lineNum,
					detail: line.trim().slice(0, 140),
					remediation: 'Use safetensors, ONNX, JSON, or yaml.safe_load instead of pickle/unsafe yaml.load.',
				});
			}
			if (/\btorch\.load\s*\(/i.test(line) && !/weights_only\s*=\s*True/i.test(line)) {
				add({
					severity: 'high',
					category: 'unsafe-deserialization',
					title: 'torch.load() without weights_only=True',
					file: f.path,
					line: lineNum,
					detail: line.trim().slice(0, 140),
					remediation: 'Pass weights_only=True to torch.load() or migrate model checkpoints to safetensors.',
				});
			}
			// 2. Executing untrusted LLM output with eval/exec
			if (/\b(?:eval|exec)\s*\([^)]*(?:response|completion|output|llm|answer|generated|prompt)/i.test(line)) {
				add({
					severity: 'critical',
					category: 'output-validation',
					title: 'Direct eval()/exec() on LLM/model output',
					file: f.path,
					line: lineNum,
					detail: line.trim().slice(0, 140),
					remediation: 'Never pass model output directly to eval/exec; use structured JSON tool dispatch or an isolated sandbox.',
				});
			}
			// 3. Direct system prompt string concatenation with raw user input
			if (/(?:system_?prompt|systemMessage)\s*[:=]\s*(?:f["']|`[^`]*\$\{|["'][^"']*["']\s*\+)\s*[^;\n]*(?:req\.|user_?input|query|message|body\.)/i.test(line)) {
				add({
					severity: 'high',
					category: 'prompt-injection',
					title: 'Untrusted user input interpolated directly into system prompt',
					file: f.path,
					line: lineNum,
					detail: line.trim().slice(0, 140),
					remediation: 'Keep system instructions immutable; pass user inputs and retrieved documents strictly in separate delimited user/context messages.',
				});
			}
			// 4. Hardcoded AI provider keys
			if (/\b(?:sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|AIzaSy[A-Za-z0-9_-]{24,}|hf_[A-Za-z0-9]{20,})\b/.test(line)) {
				add({
					severity: 'critical',
					category: 'secret-leak',
					title: 'Hardcoded AI provider API key detected (redacted)',
					file: f.path,
					line: lineNum,
					detail: 'Credential literal matching OpenAI/Anthropic/NVIDIA/Gemini/HuggingFace key format.',
					remediation: 'Revoke exposed credential immediately and load keys strictly from environment variables or Kodia encrypted storage.',
				});
			}
			// 5. Logging raw prompts/PII indiscriminately
			if (/console\.log\s*\([^)]*(?:apiKey|api_key|authorization|bearer|password)/i.test(line)) {
				add({
					severity: 'high',
					category: 'data-privacy',
					title: 'Potential secret or auth header logged to console',
					file: f.path,
					line: lineNum,
					detail: line.trim().slice(0, 140),
					remediation: 'Redact secrets and PII before structured telemetry logging.',
				});
			}
		}
	}

	const criticalCount = findings.filter(f => f.severity === 'critical').length;
	const highCount = findings.filter(f => f.severity === 'high').length;
	let score = 100 - criticalCount * 28 - highCount * 14 - findings.filter(f => f.severity === 'medium').length * 6;
	score = Math.max(0, Math.min(100, score));

	return {
		score,
		filesScanned: codeFiles.length,
		criticalCount,
		highCount,
		findings,
		protectionsDetected: [...protections],
		highImpactNotices: [...highImpactNotices],
		summary: `AI Security & Governance Score: ${score}/100 across ${codeFiles.length} file(s) (${criticalCount} critical, ${highCount} high, ${findings.length} total finding(s)).`,
	};
}

// ============================================================================
// 7. NL-TO-WORKFLOW COMPILER, RESEARCH SYNTHESIS & FAILURE DIAGNOSIS
// ============================================================================

export function compileNaturalLanguageWorkflow(opts: {
	name: string;
	instruction: string;
	trigger?: 'manual' | 'schedule' | 'webhook' | 'event';
}): AIWorkflowDefinition {
	const lower = opts.instruction.toLowerCase();
	const steps: AIWorkflowStep[] = [];
	const push = (step: Omit<AIWorkflowStep, 'id'>) => {
		steps.push({ id: `step-${steps.length + 1}`, ...step });
	};

	push({
		name: 'Ingest & Validate Input',
		kind: 'ingest',
		description: `Load and validate source inputs for "${opts.name}" with schema checks and secret/PII redaction.`,
		toolOrAdapter: 'ai_profile_dataset / read_file',
		maxRetries: 2,
	});

	if (/\b(rag|document|pdf|knowledge|search|retriev|index)\b/.test(lower)) {
		push({
			name: 'Retrieve Grounded Knowledge',
			kind: 'retrieve',
			description: 'Query hybrid RAG index to gather relevant chunks with line-level citations.',
			toolOrAdapter: 'ai_rag_query',
			maxRetries: 2,
		});
	}

	push({
		name: 'AI Reasoning & Structured Synthesis',
		kind: 'llm_reason',
		description: `Execute model-agnostic structured reasoning for: ${opts.instruction.slice(0, 140)}`,
		toolOrAdapter: 'model_gateway',
		maxRetries: 3,
	});

	if (/\b(approv|human|review|payment|deploy|send email|delete|publish|escalat)\b/.test(lower)) {
		push({
			name: 'Human-in-the-Loop Approval Gate',
			kind: 'human_approval',
			description: 'Pause for explicit human confirmation before high-impact external action or irreversible state change.',
			requiresApproval: true,
			maxRetries: 0,
		});
	}

	push({
		name: 'Execute Verified Action',
		kind: 'tool_action',
		description: 'Apply verified output to target workspace, API, database, or report artifact.',
		toolOrAdapter: 'tools_dispatcher',
		maxRetries: 2,
	});

	push({
		name: 'Evaluate & Record Trace',
		kind: 'evaluate',
		description: 'Verify output schema, groundedness, and record execution trace into observability logs.',
		toolOrAdapter: 'ai_evaluate_system',
		maxRetries: 1,
	});

	const now = new Date().toISOString();
	return {
		id: `wf-${opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'workflow'}-${Date.now().toString(36)}`,
		name: opts.name.trim(),
		description: opts.instruction.trim(),
		trigger: opts.trigger ?? (/\b(daily|hourly|weekly|every|cron|schedule)\b/.test(lower) ? 'schedule' : /\b(webhook|http|api trigger)\b/.test(lower) ? 'webhook' : 'manual'),
		version: 1,
		steps,
		createdAt: now,
		updatedAt: now,
	};
}

export function analyzeAIResearchTopic(topic: string): AIResearchBrief {
	const routing = routeEngineeringRequest(topic);
	const disciplines: readonly AIDisciplineId[] = routing.detectedDisciplines.length > 0 ? routing.detectedDisciplines : ['ai_research'];
	return {
		topic,
		disciplines,
		establishedApproaches: [
			{
				method: 'Strong Deterministic / Classical Baseline',
				strengths: 'Fast, interpretable, low variance, establishes an honest lower bound.',
				limitations: 'May saturate on complex unstructured multimodal or long-horizon tasks.',
				benchmarkFocus: 'Accuracy/F1 + Latency p95 + Compute cost',
			},
			{
				method: 'Hybrid Retrieval / Parameter-Efficient Neural Adaptation',
				strengths: 'High sample efficiency, transparent provenance, strong domain transfer.',
				limitations: 'Sensitive to chunking quality, data leakage, and distribution drift.',
				benchmarkFocus: 'Recall@K / Groundedness / Held-out Task F1',
			},
			{
				method: 'Verifier-Guided Iterative / Neuro-Symbolic Approach',
				strengths: 'Combines neural reasoning with formal/executable checks for high precision.',
				limitations: 'Higher compute/latency per query; requires explicit verifier construction.',
				benchmarkFocus: 'Verified Pass@1, Calibration, Error Recovery Rate',
			},
		],
		hypotheses: [
			`H1: Pairing a strong domain-specific baseline for "${topic}" with automated verification/evaluation yields higher reliability per dollar than scaling model size alone.`,
			`H2: Separating retrieval/representation improvements from decoding/prompting via controlled ablations isolates the true gain driver.`,
		],
		experimentDesign: {
			baseline: 'Implement and measure the simplest reproducible baseline first using ai_experiment_manage.',
			variables: ['Model architecture / adapter rank', 'Retrieval chunking & top-K / feature set', 'Decoding / regularization hyperparameters'],
			primaryMetrics: AI_DISCIPLINES.find(d => d.id === disciplines[0])?.keyMetrics ?? ['Primary Task Metric', 'Latency p95', 'Cost/Run'],
			reproducibilityControls: ['Pin random seeds and dataset SHA-256 fingerprint via ai_profile_dataset', 'Use stratified held-out evaluation split (never evaluate on training data)', 'Record every run in .kodia/ai/experiments.json'],
		},
		epistemicNote: 'This synthesis separates established engineering patterns from testable hypotheses. Run web_search for latest papers and execute real workspace experiments before claiming empirical superiority.',
	};
}

export function diagnoseAIFailure(opts: { errorSummary: string; logs?: string; component?: string }): AIFailureDiagnosisReport {
	const text = `${opts.errorSummary} ${opts.logs ?? ''} ${opts.component ?? ''}`.toLowerCase();

	if (/out of memory|cuda oom|cublas|vram|mps backend out of memory/.test(text)) {
		return {
			category: 'training_oom',
			severity: 'critical',
			likelyRootCauses: ['Micro-batch size or max sequence length exceeds available GPU VRAM.', 'Optimizer states (FP32 Adam) + activations not using gradient checkpointing or BF16/QLoRA.'],
			diagnosticCommands: ['ai_probe_compute_hardware', 'nvidia-smi'],
			concreteRepairs: ['Enable gradient checkpointing and BF16/FP16 mixed precision.', 'Halve per-device batch size and increase gradient_accumulation_steps proportionally.', 'Switch to 4-bit NF4 QLoRA + paged_adamw_8bit optimizer.'],
			verificationSteps: ['Run a 5-step training smoke test and verify peak VRAM stays <85% capacity.'],
		};
	}
	if (/nan loss|inf|exploding gradient|diverge/.test(text)) {
		return {
			category: 'training_divergence',
			severity: 'high',
			likelyRootCauses: ['Learning rate too high or missing warmup schedule.', 'FP16 overflow (prefer BF16) or unnormalized/NaN values in training dataset.'],
			diagnosticCommands: ['ai_profile_dataset (check missing/extreme numeric values)'],
			concreteRepairs: ['Lower learning rate 3x–5x, enable gradient clipping (max_norm=1.0), and add 5% linear warmup.', 'Switch FP16 to BF16 and clean NaN/Inf rows in dataset preprocessing.'],
			verificationSteps: ['Verify monotonic loss decrease over 50 steps and log in ai_experiment_manage.'],
		};
	}
	if (/hallucinat|ungrounded|wrong citation|rag|low recall|irrelevant chunk/.test(text)) {
		return {
			category: 'rag_low_recall',
			severity: 'high',
			likelyRootCauses: ['Chunk size splits key context across boundaries or lacks section metadata.', 'Pure vector search misses exact identifiers/acronyms (or vice versa).'],
			diagnosticCommands: ['ai_rag_evaluate', 'ai_rag_query'],
			concreteRepairs: ['Switch to hybrid BM25 + semantic retrieval with 15% chunk overlap and section headings.', 'Add query expansion/rewriting and enforce strict citation grounding prompts with refusal when context is missing.'],
			verificationSteps: ['Re-run ai_rag_evaluate and verify Recall@K and Groundedness improve over baseline.'],
		};
	}
	if (/429|rate limit|quota|timeout|503|overloaded/.test(text)) {
		return {
			category: 'provider_rate_limit',
			severity: 'high',
			likelyRootCauses: ['Burst concurrency exceeded provider RPM/TPM limits or upstream outage.', 'Missing retry backoff or fallback model configuration.'],
			diagnosticCommands: ['ai_check_provider_capabilities'],
			concreteRepairs: ['Add exponential backoff with jitter + concurrency semaphore.', 'Configure fallback models in Kodia Models & Routing settings and enable prompt/response caching.'],
			verificationSteps: ['Test automatic failover under simulated 429 and confirm request completion.'],
		};
	}
	if (/infinite loop|stuck|repeated tool|agent loop|max steps/.test(text)) {
		return {
			category: 'agent_loop',
			severity: 'high',
			likelyRootCauses: ['Tool returned ambiguous error causing the model to retry identical arguments.', 'Missing max-step budget or explicit failure recovery branch.'],
			diagnosticCommands: ['Inspect ExecutionObservability spans & tool error logs'],
			concreteRepairs: ['Return actionable schema/remediation messages on tool errors.', 'Add duplicate-call detection, explicit step ceiling, and checkpointed recovery state.'],
			verificationSteps: ['Run controlled failure injection test and verify bounded termination + recovery.'],
		};
	}
	return {
		category: 'general_ai_failure',
		severity: 'medium',
		likelyRootCauses: ['Contract mismatch between data/model/API layers or missing environment dependency.', 'Unverified external credential or runtime version incompatibility.'],
		diagnosticCommands: ['ai_probe_compute_hardware', 'ai_audit_security', 'workspace_diagnostics'],
		concreteRepairs: ['Reproduce failure with minimal deterministic test case.', 'Validate input/output schemas at component boundaries and repair root cause.'],
		verificationSteps: ['Re-run unit, integration, and AI evaluation tests and record proof in Verification Ledger.'],
	};
}

// ============================================================================
// 8. LLM FORMATTERS
// ============================================================================

export function formatEngineRoutingForLLM(r: EngineRoutingDecision): string {
	return [
		`# Kodia Unified Two-Engine Routing Decision`,
		`Engine Mode: **${r.engineMode}** | Requires AI: ${r.requiresAI ? 'YES' : 'NO'} (confidence ${Math.round(r.confidence * 100)}%)`,
		`Rationale: ${r.rationale}`,
		`AI Disciplines: ${r.detectedDisciplines.join(', ') || 'none (pure universal software engineering)'}`,
		`Software Domains: ${r.softwareDomains.join(', ') || 'none'}`,
		`Recommended Languages: ${r.recommendedLanguages.join(', ')}`,
		`Recommended Specialist Team: ${r.recommendedSpecialists.join(', ')}`,
		...(r.highImpactDomainFlags.length ? [`High-Impact Governance Notices:\n${r.highImpactDomainFlags.map(f => `- ${f}`).join('\n')}`] : []),
	].join('\n');
}

export function formatAIArchitectureForLLM(a: AIArchitectureReport): string {
	return [
		`# AI & System Architecture: ${a.projectTitle} (${a.engineMode})`,
		`Disciplines: ${a.disciplines.join(', ')}`,
		``,
		`## Recommended Architecture: ${a.recommendedArchitecture.name}`,
		a.recommendedArchitecture.summary,
		`- Stack: ${a.recommendedArchitecture.stack.join(' | ')}`,
		`- Est. Cost: ${a.recommendedArchitecture.estimatedMonthlyCostUsd} | Est. Latency: ${a.recommendedArchitecture.estimatedLatencyMs}`,
		`- Strengths: ${a.recommendedArchitecture.strengths.join('; ')}`,
		`- Trade-offs: ${a.recommendedArchitecture.tradeoffs.join('; ')}`,
		``,
		`## Alternatives Compared`,
		...a.alternatives.map(alt => `- **${alt.name}** (${alt.estimatedMonthlyCostUsd}, ${alt.estimatedLatencyMs}): ${alt.summary}`),
		``,
		`## Security & Evaluation`,
		...a.evaluationStrategy.map(e => `- Eval: ${e}`),
		...a.securityControls.map(s => `- Security: ${s}`),
		``,
		`## Architecture Diagram`,
		'```mermaid',
		a.mermaidDiagram,
		'```',
	].join('\n');
}

export function formatFactoryBlueprintForLLM(b: OneCommandFactoryBlueprint): string {
	return [
		`# Kodia One-Command AI Product Factory Blueprint (${b.id})`,
		`Objective: ${b.objective}`,
		formatEngineRoutingForLLM(b.routing),
		``,
		`## Shared Cross-Engine Contracts`,
		...b.sharedContracts.map(c => `- ${c}`),
		``,
		`## Execution Phases (${b.phases.length})`,
		...b.phases.map(p => `${p.phaseNumber}. **${p.name}** [${p.ownerEngine}] (${p.specialists.join(', ')})\n   Deliverables: ${p.deliverables.join('; ')}\n   Gate: ${p.verificationGate}`),
		``,
		`## Production Readiness & Explicit Limitations`,
		...b.productionReadinessChecklist.map(c => `- [ ] ${c}`),
		...b.explicitAssumptions.map(a => `- Assumption: ${a}`),
		...b.missingExternalDependencies.map(m => `- External Dependency Required: ${m}`),
	].join('\n');
}
