import { describe, expect, it } from 'vitest'

import {
  buildSemanticMemoryNoPythonMessage,
  buildSemanticMemoryPythonRequirementMessage,
  isSemanticMemoryPythonCompatible,
  isPreferredSemanticMemoryPython,
  normalizeSemanticMemoryInstallError,
  parsePythonVersion,
} from './semanticMemorySupport'

describe('semantic memory support', () => {
  it('parses python versions', () => {
    expect(parsePythonVersion('3.10.21')).toEqual({
      major: 3,
      minor: 10,
      patch: 21,
      raw: '3.10.21',
    })
  })

  it('checks python compatibility against the semantic runtime minimum', () => {
    expect(isSemanticMemoryPythonCompatible(parsePythonVersion('3.10.0'))).toBe(true)
    expect(isSemanticMemoryPythonCompatible(parsePythonVersion('3.8.18'))).toBe(false)
    expect(isSemanticMemoryPythonCompatible(parsePythonVersion('3.9.18'))).toBe(false)
    expect(isSemanticMemoryPythonCompatible(parsePythonVersion('3.13.2'))).toBe(true)
  })

  it('marks current preferred system python versions', () => {
    expect(isPreferredSemanticMemoryPython(parsePythonVersion('3.11.9'))).toBe(true)
    expect(isPreferredSemanticMemoryPython(parsePythonVersion('3.12.4'))).toBe(true)
    expect(isPreferredSemanticMemoryPython(parsePythonVersion('3.10.14'))).toBe(false)
  })

  it('normalizes pip compatibility failures into a user-facing requirement message', () => {
    const raw = [
      'ERROR: Ignored the following versions that require a different python version: 5.3.0 Requires-Python >=3.10',
      'ERROR: Could not find a version that satisfies the requirement sentence-transformers==5.3.0',
    ].join('\n')

    expect(normalizeSemanticMemoryInstallError(raw, '3.9.6')).toBe(
      buildSemanticMemoryPythonRequirementMessage('3.9.6'),
    )
  })

  it('normalizes partial runtime import failures into a repair message', () => {
    expect(
      normalizeSemanticMemoryInstallError("ModuleNotFoundError: No module named 'sentence_transformers'"),
    ).toBe('The semantic runtime is incomplete or damaged. Repair semantic retrieval to rebuild it.')
  })

  it('normalizes sqlite capability failures into a repair message', () => {
    expect(
      normalizeSemanticMemoryInstallError("AttributeError: 'sqlite3.Connection' object has no attribute 'enable_load_extension'"),
    ).toContain('cannot activate sqlite-vec')
  })

  it('explains the managed runtime fallback when python is missing', () => {
    expect(buildSemanticMemoryNoPythonMessage()).toContain('provision a managed runtime automatically')
  })
})
