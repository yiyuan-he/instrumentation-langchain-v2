import { Span, SpanKind, Tracer, SpanStatusCode } from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';
import { GenAIOperationValues, Span_Attributes } from './span-attributes.ts';
import { Serialized } from '@langchain/core/load/serializable';
import { ChainValues } from '@langchain/core/utils/types';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { LLMResult } from '@langchain/core/outputs';
import { AgentAction, AgentFinish } from '@langchain/core/agents';

// Define types to match LangChain's TypeScript interfaces
type BaseMessage = any;

const ASSOCIATION_PROPERTIES_KEY = Symbol('association_properties');
const _SUPPRESS_INSTRUMENTATION_KEY = Symbol('suppress-instrumentation');

class SpanHolder {
  span: Span;
  children: string[];
  startTime: number;
  requestModel?: string;

  constructor(span: Span, children: string[] = [], requestModel?: string) {
    this.span = span;
    this.children = children;
    this.startTime = Date.now();
    this.requestModel = requestModel;
  }
}

function _setRequestParams(span: Span, kwargs: Record<string, any>, spanHolder: SpanHolder): void {
  let model: string | undefined;

  for (const modelTag of ['model_id', 'base_model_id', 'ls_model_name']) {
    if (kwargs[modelTag] !== undefined) {
      spanHolder.requestModel = kwargs[modelTag];
      model = kwargs[modelTag];
      break;
    } else if ((kwargs.invocation_params || {})[modelTag] !== undefined) {
      spanHolder.requestModel = kwargs.invocation_params[modelTag];
      model = kwargs.invocation_params[modelTag];
      break;
    }
  }

  if (spanHolder.requestModel === undefined) {
    model = undefined;
  }

  _setSpanAttribute(span, Span_Attributes.GEN_AI_REQUEST_MODEL, model);
  _setSpanAttribute(span, Span_Attributes.GEN_AI_RESPONSE_MODEL, model);

  const params = kwargs.invocation_params 
    ? (kwargs.invocation_params.params || kwargs.invocation_params) 
    : kwargs;

  _setSpanAttribute(
    span,
    Span_Attributes.GEN_AI_REQUEST_MAX_TOKENS,
    params.ls_max_tokens || params.ls_max_new_tokens
  );

  _setSpanAttribute(
    span,
    Span_Attributes.GEN_AI_REQUEST_TEMPERATURE,
    params.ls_temperature
  );

  _setSpanAttribute(span, Span_Attributes.GEN_AI_REQUEST_TOP_P, params.ls_top_p);
}

function _setSpanAttribute(span: Span, name: string, value: any): void {
  if (value !== undefined && value !== null && value !== '') {
    span.setAttribute(name, value);
  }
}

function _sanitizeMetadataValue(value: any): any {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean' || typeof value === 'string' || 
      typeof value === 'number' || Buffer.isBuffer(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(v => String(_sanitizeMetadataValue(v)));
  }

  return String(value);
}

export class OpenTelemetryCallbackHandler extends BaseCallbackHandler {
  public tracer: Tracer;
  public spanMapping: Map<string, SpanHolder> = new Map();
  name = "opentelemetry-callback-handler";

  constructor(tracer: Tracer) {
    super();
    this.tracer = tracer;
    console.log('OpenTelemetryCallbackHandler initialized');
  }

  private _endSpan(span: Span, runId: string): void {
    const spanHolder = this.spanMapping.get(runId);
    if (spanHolder) {
      for (const childId of spanHolder.children) {
        const childSpanHolder = this.spanMapping.get(childId);
        if (childSpanHolder) {
          childSpanHolder.span.end();
          this.spanMapping.delete(childId);
        }
      }
      span.end();
    }
  }

  private _createSpan(
    runId: string,
    parentRunId: string | undefined,
    spanName: string,
    kind: SpanKind = SpanKind.INTERNAL,
    metadata?: Record<string, any>
  ): Span {
    metadata = metadata || {};

    if (metadata !== null) {
      const currentAssociationProperties = context.active().getValue(ASSOCIATION_PROPERTIES_KEY) || {};
      const sanitizedMetadata = {};
      
      for (const [k, v] of Object.entries(metadata)) {
        if (v !== null && v !== undefined) {
          sanitizedMetadata[k] = _sanitizeMetadataValue(v);
        }
      }
      
      // Assuming context.attach() is the equivalent method to Python's context_api.attach()
      context.active().setValue(
        ASSOCIATION_PROPERTIES_KEY,
        { ...currentAssociationProperties, ...sanitizedMetadata }
      );
    }

    let span: Span;
    if (parentRunId && this.spanMapping.has(parentRunId)) {
      const parentSpan = this.spanMapping.get(parentRunId)!.span;
      const ctx = trace.setSpan(context.active(), parentSpan);
      span = this.tracer.startSpan(spanName, { kind }, ctx);
    } else {
      span = this.tracer.startSpan(spanName, { kind });
    }

    let modelId = 'unknown';
    
    if (metadata.invocation_params) {
      if (metadata.invocation_params.base_model_id) {
        modelId = metadata.invocation_params.base_model_id;
      } else if (metadata.invocation_params.model_id) {
        modelId = metadata.invocation_params.model_id;
      }
    }

    this.spanMapping.set(runId, new SpanHolder(span, [], modelId));

    if (parentRunId && this.spanMapping.has(parentRunId)) {
      this.spanMapping.get(parentRunId)!.children.push(runId);
    }
    
    return span;
  }

  private _getNameFromCallback(
    serialized: Record<string, any>,
    tags?: string[],
    metadata?: Record<string, any>,
    kwargs: Record<string, any> = {}
  ): string {
    if (serialized && serialized.kwargs && serialized.kwargs.name) {
      return serialized.kwargs.name;
    }
    if (kwargs.name) {
      return kwargs.name;
    }
    if (serialized.name) {
      return serialized.name;
    }
    if ('id' in serialized) {
      return serialized.id[serialized.id.length - 1];
    }
    return 'unknown';
  }

  private _handleError(
    error: Error,
    runId: string,
    parentRunId?: string,
    kwargs: Record<string, any> = {}
  ): void {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }

    if (!this.spanMapping.has(runId)) {
      return;
    }

    const span = this.spanMapping.get(runId)!.span;
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message
    });
    span.recordException(error);
    this._endSpan(span, runId);
  }


  async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string, 
    parentRunId?: string, 
    extraParams?: Record<string, unknown>, 
    tags?: string[], 
    metadata?: Record<string, unknown>, 
    runName?: string
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }
    
    // Extract model ID from extra params if available
    let modelId;
    if (extraParams?.invocation_params && typeof extraParams.invocation_params === 'object' && 
        'model_id' in extraParams.invocation_params) {
      modelId = extraParams.invocation_params.model_id;
    }

    // Determine the name to use
    let name = llm.name;
    if (modelId) {
      name = modelId as string;
    }
    if (name === undefined || runName === undefined) {
      console.log("undefined value detected");
       console.log(`ChatStart serialized: ${JSON.stringify(llm, null, 2)}`);
      console.log(`ChatStart metadata: ${JSON.stringify(metadata, null, 2)}`);
      console.log(`ChatStart extraParams: ${JSON.stringify(extraParams, null, 2)}`);
      console.log(`ChatStart messages: ${JSON.stringify(messages, null, 2)}`);
      console.log(`ChatStart tags: ${JSON.stringify(tags, null, 2)}`);
    }
    console.log(`🗣️ Starting chat model: ${name}, runName: ${runName}`);
    // console.log(`ChatStart extraParams: ${JSON.stringify(extraParams, null, 2)}`);
    // console.log(`ChatStart metadata: ${JSON.stringify(metadata, null, 2)}`);

    // const spanName = `\${GenAIOperationValues.CHAT} \${name}`;
    const spanName = GenAIOperationValues.CHAT + " " + name;
    const span = this._createSpan(runId, parentRunId,
                                  spanName, 
                                  SpanKind.INTERNAL, metadata);

    if (extraParams) {
      _setRequestParams(span, extraParams, this.spanMapping.get(runId)!);
    }
    if (metadata) {
      _setRequestParams(span, metadata, this.spanMapping.get(runId)!);
      _setSpanAttribute(span, Span_Attributes.GEN_AI_SYSTEM, metadata.ls_model_name);
    }
   
    // return await context.with(context.active().setValue(llm.id, span), async () => {});
  }

  async handleLLMStart(
    llm: Serialized, 
    prompt: string[], 
    runId: string, 
    parentRunId?: string, 
    extraParams?: Record<string, unknown>, 
    tags?: string[], 
    metadata?: Record<string, unknown>, 
    runName?: string
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }

    let modelId;
    
    if (extraParams?.invocation_params && 
        (extraParams.invocation_params as any).model_id) {
      modelId = (extraParams.invocation_params as any).model_id;
    }
    let name = this._getNameFromCallback(llm, undefined, undefined, extraParams || {});
    if (modelId) {
      name = modelId;
    }

    const spanName = GenAIOperationValues.CHAT + " " + name;
    const span = this._createSpan(
      runId,
      parentRunId,
      spanName,
      SpanKind.CLIENT,
      metadata || {}
    );

    _setSpanAttribute(span, Span_Attributes.GEN_AI_OPERATION_NAME, GenAIOperationValues.CHAT);
    _setRequestParams(span, extraParams || {}, this.spanMapping.get(runId)!);
    _setSpanAttribute(span, Span_Attributes.GEN_AI_SYSTEM, llm.name);
    _setSpanAttribute(span, Span_Attributes.GEN_AI_OPERATION_NAME, 'text_completion');


    console.log(`🗣️ Starting llmStart`);
  }

  async handleLLMEnd(
    output: LLMResult, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[], 
    extraParams?: Record<string, unknown>
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }

    if (!this.spanMapping.has(runId)) {
      console.log("LLMEND cannot find span: context issue");
      return;
    }

    const span = this.spanMapping.get(runId)!.span;

    let modelName;
    if (output.llmOutput) {
      modelName = output.llmOutput.model_name || output.llmOutput.model_id;
      
      if (modelName) {
        _setSpanAttribute(span, Span_Attributes.GEN_AI_RESPONSE_MODEL, modelName);
      }
      
      const id = output.llmOutput.id;
      if (id !== undefined && id !== '') {
        _setSpanAttribute(span, Span_Attributes.GEN_AI_RESPONSE_ID, id);
      }

      const tokenUsage = output.llmOutput.token_usage || output.llmOutput.usage;
      
      if (tokenUsage) {
        const promptTokens = tokenUsage.prompt_tokens || 
                            tokenUsage.input_token_count || 
                            tokenUsage.input_tokens;
                            
        const completionTokens = tokenUsage.completion_tokens || 
                                tokenUsage.generated_token_count || 
                                tokenUsage.output_tokens;

        _setSpanAttribute(span, Span_Attributes.GEN_AI_USAGE_INPUT_TOKENS, promptTokens);
        _setSpanAttribute(span, Span_Attributes.GEN_AI_USAGE_OUTPUT_TOKENS, completionTokens);
      }
    }

    this._endSpan(span, runId);
  }

  async handleLLMError(
    err: any, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[], 
    extraParams?: Record<string, unknown>
  ): Promise<any> {
    this._handleError(err, runId, parentRunId, extraParams);
  }

  async handleChainStart(
    chain: Serialized, 
    inputs: ChainValues, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[], 
    metadata?: Record<string, unknown>, 
    runType?: string, 
    runName?: string,
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }
    // ///////// debugging
    // console.log('chainStart runType:', runType);
    console.log('chainStart runName:', runName);

    // console.log(`ChatStart extraParams: ${JSON.stringify(extraParams, null, 2)}`);
    // console.log(`ChatStart metadata: ${JSON.stringify(metadata, null, 2)}`);

    const name = this._getNameFromCallback(chain, tags, metadata, {});

    // const spanName = `chain \${name}`;
    const spanName = `chain ${runName}`;
    const span = this._createSpan(runId, parentRunId, spanName, SpanKind.INTERNAL, metadata);

    const spanContext = trace.setSpan(context.active(), span);

     return context.with(spanContext, async () => {
        if (metadata && metadata.agent_name) {
            _setSpanAttribute(span, Span_Attributes.GEN_AI_AGENT_NAME, metadata.agent_name);
        }
        _setSpanAttribute(span, 'gen_ai.prompt', String(inputs));
    });


    // if (metadata && metadata.agent_name) {
    //   _setSpanAttribute(span, Span_Attributes.GEN_AI_AGENT_NAME, metadata.agent_name);
    // }

    // _setSpanAttribute(span, 'gen_ai.prompt', String(inputs));

    console.log(`🗣️ Starting chain`);
  }


  async handleChainEnd(
    outputs: ChainValues, 
    runId: string, 
    parentRunId?: string,
    tags?: string[], 
    kwargs?: {
        inputs?: Record<string, unknown>;
    }
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }

    if (!this.spanMapping.has(runId)) {
      return;
    }

    const spanHolder = this.spanMapping.get(runId)!;
    const span = spanHolder.span;
    
    _setSpanAttribute(span, 'gen_ai.completion', String(outputs));
    this._endSpan(span, runId);
  }

  async handleChainError(
    err: any, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[], 
    kwargs?: {
        inputs?: Record<string, unknown>;
    }
  ): Promise<any> {
     this._handleError(err, runId, parentRunId, kwargs);
  }

  async handleToolStart(
    tool: Serialized, 
    input: string, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[], 
    metadata?: Record<string, unknown>, 
    runName?: string
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }

    const name = this._getNameFromCallback(tool, undefined, undefined, {});
    
    const spanName = `execute_tool ${runName}`;
    const span = this._createSpan(runId, parentRunId, spanName, SpanKind.INTERNAL, metadata);

    _setSpanAttribute(span, 'gen_ai.tool.input', input);

    if (tool.id) {
      _setSpanAttribute(span, Span_Attributes.GEN_AI_TOOL_CALL_ID, tool.id);
    }
    
    // need to find alternative to below
    // if (tool.description) {
    //   _setSpanAttribute(span, Span_Attributes.GEN_AI_TOOL_DESCRIPTION, tool.description);
    // }
    console.log("toolStart runName: ", runName);

    _setSpanAttribute(span, Span_Attributes.GEN_AI_TOOL_NAME, name);
    _setSpanAttribute(span, Span_Attributes.GEN_AI_OPERATION_NAME, 'execute_tool');

    console.log(`🗣️ Starting tool start`);
  }

  async handleToolEnd(
    output: any, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[],
  ): Promise<any> {
    if (context.active().getValue(_SUPPRESS_INSTRUMENTATION_KEY)) {
      return;
    }

    if (!this.spanMapping.has(runId)) {
      return;
    }

    const span = this.spanMapping.get(runId)!.span;
    _setSpanAttribute(span, 'gen_ai.tool.output', String(output));
    this._endSpan(span, runId);
  }

  async handleToolError(
    err: any, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[]
  ): Promise<any> {
    this._handleError(err, runId, parentRunId, {});
  }

  async handleAgentAction(
    action: AgentAction, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[],
  ): Promise<void> {
    const tool = action.tool;
    const toolInput = action.toolInput;

    if (this.spanMapping.has(runId)) {
      const span = this.spanMapping.get(runId)!.span;
      
      _setSpanAttribute(span, 'gen_ai.agent.tool.input', toolInput);
      _setSpanAttribute(span, 'gen_ai.agent.tool.name', tool);
      _setSpanAttribute(span, Span_Attributes.GEN_AI_OPERATION_NAME, 'invoke_agent');
    }

    console.log(`🗣️ Starting agent action`);
  }

  async handleAgentEnd(
    action: AgentFinish, 
    runId: string, 
    parentRunId?: string, 
    tags?: string[],
  ): Promise<void> {
    if (this.spanMapping.has(runId)) {
      const span = this.spanMapping.get(runId)!.span;
      _setSpanAttribute(span, 'gen_ai.agent.tool.output', action.returnValues.output);
    }
  }
}
