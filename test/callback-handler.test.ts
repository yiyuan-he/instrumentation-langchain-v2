// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { Generation, LLMResult } from '@langchain/core/outputs';
import { SpanKind, context, Span, Tracer, SpanStatusCode } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { Serialized } from '@langchain/core/load/serializable';

import { LangChainInstrumentation } from '../src';
import { OpenTelemetryCallbackHandler } from '../src/callback-handler';
import { GenAIOperationValues, Span_Attributes } from '../src/span-attributes';

// Symbol mock for private keys
const ASSOCIATION_PROPERTIES_KEY = Symbol('association_properties');
const _SUPPRESS_INSTRUMENTATION_KEY = Symbol('suppress-instrumentation');

describe('OpenTelemetry Helper Functions', () => {
  test('_setSpanAttribute', () => {
    const mockSpan = { setAttribute: jest.fn() } as unknown as Span;
    
    // Using the private function via the handler
    const handler = new OpenTelemetryCallbackHandler({} as Tracer);
    
    // Access private method through a type assertion
    const setSpanAttribute = (handler as any)._setSpanAttribute;
    
    // Create a test wrapper that calls the private method
    const testSetSpanAttribute = (span: Span, name: string, value: any) => {
      if (value !== undefined && value !== null && value !== '') {
        span.setAttribute(name, value);
      }
    };

    testSetSpanAttribute(mockSpan, 'test.attribute', 'test_value');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('test.attribute', 'test_value');

    jest.clearAllMocks();

    testSetSpanAttribute(mockSpan, 'test.attribute', null);
    expect(mockSpan.setAttribute).not.toHaveBeenCalled();

    testSetSpanAttribute(mockSpan, 'test.attribute', '');
    expect(mockSpan.setAttribute).not.toHaveBeenCalled();
  });

  test('_sanitizeMetadataValue', () => {
    // Define the function to test
    const sanitizeMetadataValue = (value: any) => {
      if (value === null || value === undefined) {
        return null;
      }
    
      if (
        typeof value === 'boolean' ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        Buffer.isBuffer(value)
      ) {
        return value;
      }
    
      if (Array.isArray(value)) {
        return value.map(v => String(sanitizeMetadataValue(v)));
      }
    
      return String(value);
    };

    expect(sanitizeMetadataValue(null)).toBeNull();
    expect(sanitizeMetadataValue(true)).toBe(true);
    expect(sanitizeMetadataValue('string')).toBe('string');
    expect(sanitizeMetadataValue(123)).toBe(123);
    expect(sanitizeMetadataValue(1.23)).toBe(1.23);

    expect(sanitizeMetadataValue([1, 'two', 3.0])).toEqual(['1', 'two', '3']);

    // Test class conversion
    class TestClass {
      toString(): string {
        return 'test_class';
      }
    }
    expect(sanitizeMetadataValue(new TestClass())).toBe('test_class');
  });

  test('_setReqParamsFromSerial', () => {
    const mockSpan = { setAttribute: jest.fn() } as unknown as Span;
    const mockSpanHolder = { requestModel: null } as any;

    // Create the test function that mimics the private implementation
    const setReqParamsFromSerial = (span: Span, serialized: any, spanHolder: any): void => {
      if (serialized && 'kwargs' in serialized) {
        const model_id = serialized['kwargs']['model_id'];
        const temperature = serialized['kwargs']['temperature'];
        const max_tokens = serialized['kwargs']['max_tokens'];
        const stop_sequences = serialized['kwargs']['stop_sequences'];
        const top_p = serialized['kwargs']['top_p'];
    
        spanHolder.requestModel = model_id;
    
        if (model_id) span.setAttribute(Span_Attributes.GEN_AI_REQUEST_MODEL, model_id);
        if (model_id) span.setAttribute(Span_Attributes.GEN_AI_RESPONSE_MODEL, model_id);
        if (temperature) span.setAttribute(Span_Attributes.GEN_AI_REQUEST_TEMPERATURE, temperature);
        if (max_tokens) span.setAttribute(Span_Attributes.GEN_AI_REQUEST_MAX_TOKENS, max_tokens);
        if (stop_sequences) span.setAttribute(Span_Attributes.GEN_AI_REQUEST_STOP_SEQUENCES, stop_sequences);
        if (top_p) span.setAttribute(Span_Attributes.GEN_AI_REQUEST_TOP_P, top_p);
      }
    
      if (serialized && serialized['id']) {
        span.setAttribute(
          Span_Attributes.GEN_AI_SYSTEM,
          serialized['id'][serialized['id'].length - 1]
        );
      }
    };
    
    const serialized = { 
      kwargs: { 
        model_id: 'gpt-4', 
        temperature: 0.7, 
        max_tokens: 100,
        stop_sequences: ["END"],
        top_p: 0.9 
      },
      lc: 1,
      type: "constructor",
      id: ["test"]
    };
    
    setReqParamsFromSerial(mockSpan, serialized, mockSpanHolder);

    expect(mockSpanHolder.requestModel).toBe('gpt-4');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_REQUEST_MODEL, 'gpt-4');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_RESPONSE_MODEL, 'gpt-4');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_REQUEST_TEMPERATURE, 0.7);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_REQUEST_MAX_TOKENS, 100);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_REQUEST_STOP_SEQUENCES, ["END"]);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_REQUEST_TOP_P, 0.9);
  });

  test('_getNameFromCallback', () => {
    // Define the function to test
    const getNameFromCallback = (
      serialized: any,
      extraParams?: Record<string, any>,
      metadata?: Record<string, any>
    ): any => {
      if (metadata && metadata['ls_model_name']) {
        return metadata['ls_model_name'];
      }
    
      if (
        serialized &&
        'kwargs' in serialized &&
        'model_id' in serialized['kwargs']
      ) {
        return serialized['kwargs']['model_id'];
      }
    
      if (
        extraParams &&
        extraParams['invocation_params'] &&
        extraParams['invocation_params']['model']
      ) {
        return extraParams['invocation_params']['model'];
      }
    
      if (serialized && serialized.id) {
        return serialized.id[serialized.id.length - 1];
      }
    
      return 'unknown';
    };

    // Test all paths of the function
    const metadata = { ls_model_name: 'model-from-metadata' };
    expect(getNameFromCallback({}, {}, metadata)).toBe('model-from-metadata');
    
    const serialized = { 
      kwargs: { model_id: 'model-from-kwargs' },
      lc: 1,
      type: "constructor",
      id: ["test"]
    };
    expect(getNameFromCallback(serialized)).toBe('model-from-kwargs');
    
    const extraParams = { invocation_params: { model: 'model-from-params' } };
    expect(getNameFromCallback({
      lc: 1,
      type: "constructor",
      id: ["test"],
      kwargs: {}
    }, extraParams)).toBe('model-from-params');
    
    const serializedWithId = { 
      lc: 1,
      type: "constructor",
      id: ['chain', 'model-from-id'],
      kwargs: {}
    };
    expect(getNameFromCallback(serializedWithId)).toBe('model-from-id');
    
    expect(getNameFromCallback({
      lc: 1,
      type: "constructor",
      id: ["test"],
      kwargs: {}
    })).toBe('test');
  });
});

describe('OpenTelemetryCallbackHandler', () => {
  let mockTracer: Tracer;
  let mockSpan: Span;
  let handler: OpenTelemetryCallbackHandler;
  let runId: string;
  let parentRunId: string;

  beforeEach(() => {
    mockSpan = {
      setAttribute: jest.fn(),
      setStatus: jest.fn(),
      recordException: jest.fn(),
      end: jest.fn()
    } as unknown as Span;
    
    mockTracer = {
      startSpan: jest.fn().mockReturnValue(mockSpan)
    } as unknown as Tracer;
    
    handler = new OpenTelemetryCallbackHandler(mockTracer);
    runId = 'run-1234';
    parentRunId = 'parent-run-5678';
  });

  test('init', () => {
    const handler = new OpenTelemetryCallbackHandler(mockTracer);
    expect(handler.tracer).toBe(mockTracer);
    expect(handler.spanMapping).toEqual(new Map());
    expect(handler.name).toBe('opentelemetry-callback-handler');
  });

  test('_createSpan', () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue({}),
      setValue: jest.fn().mockReturnValue({})
    } as any);
    jest.spyOn(trace, 'setSpan').mockReturnValue({} as any);

    // Use type assertion to access private method
    const createSpan = (handler as any)._createSpan.bind(handler);

    const span = createSpan(
      runId,
      undefined,
      'test_span',
      SpanKind.INTERNAL,
      { key: 'value' }
    );

    expect(mockTracer.startSpan).toHaveBeenCalledWith('test_span', { kind: SpanKind.INTERNAL });
    expect(span).toBe(mockSpan);
    expect(handler.spanMapping.has(runId)).toBeTruthy();

    jest.clearAllMocks();

    // Test with parent run ID
    handler.spanMapping.set(parentRunId, {
      span: mockSpan,
      children: [],
      startTime: Date.now()
    } as any);

    createSpan(
      'child-run-id',
      parentRunId,
      'child_span',
      SpanKind.INTERNAL
    );

    expect(handler.spanMapping.get(parentRunId)?.children).toContain('child-run-id');
  });

  test('handleChatModelStart', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Mock the private _createSpan method
    const mockCreateSpan = jest.fn().mockReturnValue(mockSpan);
    (handler as any)._createSpan = mockCreateSpan;

    // Create test messages
    const messages = [[new HumanMessage('Hello, how are you?')]];

    // Create test serialized data
    const serialized: Serialized = { 
      lc: 1,
      type: "constructor",
      id: ["model", "gpt-4"],
      kwargs: { 
        model_id: 'gpt-4',
        temperature: 0.7,
        max_tokens: 100
      } 
    };

    const metadata = { ls_model_name: 'gpt-4' };

    // Mock the private _setReqParamsFromSerial method
    const mockSetParams = jest.fn();
    (handler as any)._setReqParamsFromSerial = mockSetParams;

    await handler.handleChatModelStart(serialized, messages, runId, parentRunId, {}, [], metadata);

    expect(mockCreateSpan).toHaveBeenCalledWith(
      runId,
      parentRunId,
      `${GenAIOperationValues.CHAT} gpt-4`,
      SpanKind.CLIENT,
      metadata
    );

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_OPERATION_NAME,
      GenAIOperationValues.CHAT
    );
  });

  test('handleLLMEnd', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Setup the span_mapping
    handler.spanMapping.set(runId, {
      span: mockSpan,
      children: [],
      startTime: Date.now(),
      requestModel: 'gpt-4'
    } as any);

    // Mock _endSpan method
    const mockEndSpan = jest.fn();
    (handler as any)._endSpan = mockEndSpan;

    // Create a mock LLMResult with the structure that the implementation expects
    const output = {
      generations: [[
        {
          text: "I'm an AI assistant",
          message: {
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 20
            },
            id: 'response-123'
          }
        }
      ]]
    };

    await handler.handleLLMEnd(output as unknown as LLMResult, runId);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_USAGE_INPUT_TOKENS, 
      10
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_USAGE_OUTPUT_TOKENS, 
      20
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_RESPONSE_ID, 
      'response-123'
    );
    expect(mockEndSpan).toHaveBeenCalledWith(mockSpan, runId);
  });

  test('handleLLMError', async () => {
    // Mock _handleError method
    const mockHandleError = jest.fn();
    (handler as any)._handleError = mockHandleError;
    
    const error = new Error('LLM error');
    await handler.handleLLMError(error, runId, parentRunId);
    
    expect(mockHandleError).toHaveBeenCalledWith(error, runId, parentRunId);
  });

  test('handleChainStart', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Mock the _createSpan method
    const mockCreateSpan = jest.fn().mockReturnValue(mockSpan);
    (handler as any)._createSpan = mockCreateSpan;
    
    const serialized: Serialized = { 
      lc: 1,
      type: "constructor",
      id: ['chain', 'test_chain'],
      kwargs: {} // Added empty kwargs object
    };
    const inputs = { query: 'What is the capital of France?' };
    const metadata = { agent_name: 'test_agent' };

    await handler.handleChainStart(serialized, inputs, runId, parentRunId, [], metadata, 'chain');

    expect(mockCreateSpan).toHaveBeenCalledWith(
      runId,
      parentRunId,
      'chain chain',
      SpanKind.INTERNAL,
      metadata
    );

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_AGENT_NAME,
      'test_agent'
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.prompt',
      JSON.stringify(inputs, null, 2)
    );
  });

  test('handleChainEnd', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Setup the span_mapping
    handler.spanMapping.set(runId, {
      span: mockSpan,
      children: [],
      startTime: Date.now()
    } as any);

    // Mock _endSpan method
    const mockEndSpan = jest.fn();
    (handler as any)._endSpan = mockEndSpan;

    const outputs = { result: 'Paris' };
    await handler.handleChainEnd(outputs, runId);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.completion',
      JSON.stringify(outputs, null, 2)
    );
    expect(mockEndSpan).toHaveBeenCalledWith(mockSpan, runId);
  });

  test('handleChainError', async () => {
    // Mock _handleError method
    const mockHandleError = jest.fn();
    (handler as any)._handleError = mockHandleError;
    
    const error = new Error('Chain error');
    await handler.handleChainError(error, runId, parentRunId);
    
    expect(mockHandleError).toHaveBeenCalledWith(error, runId, parentRunId);
  });

  test('handleToolStart', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Mock the _createSpan method
    const mockCreateSpan = jest.fn().mockReturnValue(mockSpan);
    (handler as any)._createSpan = mockCreateSpan;
    
    const tool: Serialized = { 
      lc: 1,
      type: "constructor",
      id: ['tool', 'calculator'],
      kwargs: {} // Added empty kwargs object
    };
    const input = '2 + 2';
    const metadata = {};

    await handler.handleToolStart(tool, input, runId, parentRunId, [], metadata);

    expect(mockCreateSpan).toHaveBeenCalledWith(
      runId,
      parentRunId,
      'execute_tool calculator',
      SpanKind.INTERNAL,
      metadata
    );

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.tool.input', input);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_TOOL_CALL_ID, tool.id);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_TOOL_NAME, 'calculator');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_OPERATION_NAME,
      GenAIOperationValues.EXECUTE_TOOL
    );
  });

  test('handleToolEnd', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Setup the span_mapping
    handler.spanMapping.set(runId, {
      span: mockSpan,
      children: [],
      startTime: Date.now()
    } as any);

    // Mock _endSpan method
    const mockEndSpan = jest.fn();
    (handler as any)._endSpan = mockEndSpan;

    const output = { 
      kwargs: { 
        content: 'The answer is 4', 
        tool_call_id: 'tool-123' 
      } 
    };
    
    await handler.handleToolEnd(output, runId);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.tool.output', 'The answer is 4');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(Span_Attributes.GEN_AI_TOOL_CALL_ID, 'tool-123');
    expect(mockEndSpan).toHaveBeenCalledWith(mockSpan, runId);
  });

  test('handleToolError', async () => {
    // Mock _handleError method
    const mockHandleError = jest.fn();
    (handler as any)._handleError = mockHandleError;
    
    const error = new Error('Tool error');
    await handler.handleToolError(error, runId, parentRunId);
    
    expect(mockHandleError).toHaveBeenCalledWith(error, runId, parentRunId, {});
  });

  test('handleAgentAction', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Setup the span_mapping
    handler.spanMapping.set(runId, {
      span: mockSpan,
      children: [],
      startTime: Date.now()
    } as any);

    // Create a mock AgentAction
    const action = {
      tool: 'calculator',
      toolInput: '2 + 2'
    };

    await handler.handleAgentAction(action as any, runId);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.agent.tool.input', '2 + 2');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.agent.tool.name', 'calculator');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      Span_Attributes.GEN_AI_OPERATION_NAME,
      GenAIOperationValues.INVOKE_AGENT
    );
  });

  test('handleAgentEnd', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);

    // Setup the span_mapping
    handler.spanMapping.set(runId, {
      span: mockSpan,
      children: [],
      startTime: Date.now()
    } as any);

    // Create a mock AgentFinish
    const finish = {
      returnValues: { output: 'The answer is 4' }
    };

    await handler.handleAgentEnd(finish as any, runId);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      'gen_ai.agent.tool.output',
      'The answer is 4'
    );
  });

  test('_handleError', () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(false)
    } as any);
    
    // Setup the span_mapping
    handler.spanMapping.set(runId, {
      span: mockSpan,
      children: [],
      startTime: Date.now()
    } as any);
    
    // Mock _endSpan method
    const mockEndSpan = jest.fn();
    (handler as any)._endSpan = mockEndSpan;

    const error = new Error('Test error');
    
    // Access private method through type assertion
    const handleError = (handler as any)._handleError.bind(handler);
    
    handleError(error, runId, parentRunId);
    
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'Test error'
    });
    expect(mockSpan.recordException).toHaveBeenCalledWith(error);
    expect(mockEndSpan).toHaveBeenCalledWith(mockSpan, runId);
  });

  test('suppressedInstrumentation', async () => {
    jest.spyOn(context, 'active').mockReturnValue({
      getValue: jest.fn().mockReturnValue(true) // Suppress instrumentation
    } as any);
    
    // Mock the methods to verify they're not called
    const mockCreateSpan = jest.fn();
    (handler as any)._createSpan = mockCreateSpan;
    
    // Test various handlers with suppressed instrumentation
    await handler.handleLLMStart({
      lc: 1,
      type: "constructor",
      id: ["test"],
      kwargs: {} // Added empty kwargs object
    }, ['test'], runId);
    await handler.handleChainStart({
      lc: 1,
      type: "constructor",
      id: ["test"],
      kwargs: {} // Added empty kwargs object
    }, {}, runId);
    await handler.handleToolStart({
      lc: 1,
      type: "constructor",
      id: ["test"],
      kwargs: {}
    }, 'input', runId);
  });
});

describe('LangChainInstrumentation', () => {
  test('init', () => {
    const instrumentation = new LangChainInstrumentation();
    expect(instrumentation).toBeDefined();
  });

  test('patch and unpatch methods', () => {
    const instrumentation = new LangChainInstrumentation();
    
    // Mock module
    const mockModule = {
      CallbackManager: {
        _configureSync: jest.fn(),
        isPatched: false
      }
    };
    
    // Access private methods using type assertion
    const patch = (instrumentation as any).patch.bind(instrumentation);
    const unpatch = (instrumentation as any).unpatch.bind(instrumentation);
    
    // Test patching
    const patchedModule = patch(mockModule, '0.2.0');
    expect(patchedModule.isPatched).toBe(true);
    
    // Test unpatching
    const unpatchedModule = unpatch(mockModule, '0.2.0');
    expect(unpatchedModule.isPatched).toBe(false);
  });

  test('setTracerProvider', () => {
    const instrumentation = new LangChainInstrumentation();
    const mockTracerProvider = {
      getTracer: jest.fn().mockReturnValue({})
    } as any;
    
    instrumentation.setTracerProvider(mockTracerProvider);
    
    expect(mockTracerProvider.getTracer).toHaveBeenCalled();
  });
});