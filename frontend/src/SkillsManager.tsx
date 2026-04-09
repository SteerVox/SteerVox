import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSearchParams } from 'react-router-dom'

import { APP_HOME_DISPLAY_PATH } from '../shared/branding'
import { BrandedProgressLoader } from './components/BrandedProgressLoader'
import { ArrowRightIcon, ErrorIcon, SparkIcon, WindowCloseIcon } from './components/BrandIcons'
import { apiDelete, apiGet, apiPost } from './lib/api'
import type { Skill, TemplateFormDraft, TemplatePackageDiagnostic } from './types'

function parseCsvList(value: string) {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function sanitizeTemplateId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '')
}

function slugifyTemplateName(value: string) {
  return sanitizeTemplateId(value.trim().replace(/\s+/g, '_')).replace(/^_+|_+$/g, '')
}

function buildTemplateId(name: string, rawId: string, skills: Skill[]) {
  const customId = sanitizeTemplateId(rawId.trim())
  if (customId) return customId

  const slug = slugifyTemplateName(name) || 'template'
  const baseId = `custom_${slug}`
  if (!skills.some((skill) => skill.id === baseId)) return baseId

  let index = 2
  while (skills.some((skill) => skill.id === `${baseId}_${index}`)) {
    index += 1
  }
  return `${baseId}_${index}`
}

function resolveToneStyle(value: TemplateFormDraft['tone']) {
  if (value === 'automatic') return null
  return value
}

function resolveDraftTargetTypes(bestUsedIn: TemplateFormDraft['best_used_in'], rawTargetTypes: string) {
  const advancedTargetTypes = parseCsvList(rawTargetTypes)
  if (advancedTargetTypes.length) return advancedTargetTypes
  return bestUsedIn === 'generic' ? [] : [bestUsedIn]
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'data' in error) {
    const detail = (error as { data?: unknown }).data
    if (typeof detail === 'string' && detail.trim()) return detail
    if (detail && typeof detail === 'object') {
      const message = 'detail' in detail
        ? detail.detail
        : 'message' in detail
          ? detail.message
          : null
      if (typeof message === 'string' && message.trim()) return message
    }
  }

  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function Banner({
  tone,
  message,
}: {
  tone: 'success' | 'error'
  message: string
}) {
  const toneClass = tone === 'success'
    ? 'border-semantic-success/20 bg-semantic-success/10 text-semantic-success'
    : 'border-semantic-error/20 bg-semantic-error/10 text-semantic-error'

  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm ${toneClass}`}>
      {message}
    </div>
  )
}

function formatToken(value: string | null | undefined) {
  if (!value) return 'Not set'

  const normalized = value
    .replace(/_/g, ' ')
    .replace(/\bide\b/gi, 'IDE')
    .replace(/\bllm\b/gi, 'LLM')

  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function formatOutputMode(value: Skill['output_mode']) {
  if (value === 'plain_text') return 'Plain text'
  if (value === 'command') return 'Command'
  if (value === 'code') return 'Code'
  return 'Bullets'
}

function formatFallbackBehavior(value: string) {
  if (value === 'selected_skill') return 'Use this template'
  if (value === 'raw_dictation') return 'Raw dictation'
  if (value === 'system_dictation') return 'Standard Dictation'
  return formatToken(value)
}

function formatTargetTypeLabel(value: string) {
  if (value === 'generic') return 'Any app'
  if (value === 'browser_doc') return 'Document editor'
  if (value === 'chat') return 'Chat'
  if (value === 'ide') return 'Code editor'
  if (value === 'social_post') return 'Social post'
  return formatToken(value)
}

function resolveTemplateSurface(skill: Skill) {
  return skill.target_types[0] ? formatTargetTypeLabel(skill.target_types[0]) : 'Any app'
}

function resolveTemplateExample(skill: Skill) {
  if (skill.id === 'system_chat_reply') return 'Example: turn this into a short teammate update.'
  if (skill.id === 'system_email_draft' || skill.id === 'system_domain_email') return 'Example: draft a concise customer email from what I just said.'
  if (skill.id === 'system_issue_ticket') return 'Example: turn this into a clear issue summary with next steps.'
  if (skill.output_mode === 'code') return 'Example: format this as a code snippet that is ready to paste.'
  if (skill.output_mode === 'command') return 'Example: convert this request into the command I should run.'
  if (skill.output_mode === 'bullets') return 'Example: make this a short bullet list.'
  if (skill.target_types.includes('chat')) return 'Example: make this sound natural in chat.'
  if (skill.target_types.includes('ide')) return 'Example: rewrite this for a code or terminal workflow.'
  if (skill.target_types.includes('browser_doc')) return 'Example: turn this into a polished document-style note.'
  if (skill.target_types.includes('social_post')) return 'Example: turn this into a polished post for the platform I am writing in.'
  return 'Example: rewrite this into the final text I want to paste.'
}

function buildTemplatePrompt(draft: {
  whatItDoes: string
  tone: TemplateFormDraft['tone']
  outputMode: Skill['output_mode']
  promptDetails: string
}) {
  const body = draft.whatItDoes.trim()
  const toneLabel = draft.tone === 'automatic' ? 'Automatic' : formatToken(draft.tone)
  const outputLabel = formatOutputMode(draft.outputMode)
  const details = draft.promptDetails.trim()

  return [
    '## Purpose',
    body,
    '',
    '## Output Contract',
    `- Tone: ${toneLabel}`,
    `- Output: ${outputLabel}`,
    '- Return only the final text that should be used.',
    details ? '' : null,
    details ? '## Advanced Instructions' : null,
    details || null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function parseTemplatePrompt(prompt: string) {
  const purposeMatch = /## Purpose\s+([\s\S]*?)(?:\n## |\s*$)/.exec(prompt)
  const advancedMatch = /## Advanced Instructions\s+([\s\S]*)$/m.exec(prompt)

  return {
    purpose: purposeMatch?.[1]?.trim() || prompt.trim(),
    advancedInstructions: advancedMatch?.[1]?.trim() || '',
  }
}

type SkillGroupKey = 'core' | 'communication' | 'structured' | 'code' | 'custom'

const SKILL_GROUP_META: Record<Exclude<SkillGroupKey, 'custom'>, { label: string; description: string }> = {
  core: {
    label: 'Core presets',
    description: 'General writing and default dictation behavior.',
  },
  communication: {
    label: 'Replies and email',
    description: 'Short messages, polished replies, and email drafting.',
  },
  structured: {
    label: 'Structured output',
    description: 'Tickets, bullets, summaries, and domain notes.',
  },
  code: {
    label: 'Code and terminal',
    description: 'Commands, snippets, refactors, and prompt/workflow work.',
  },
}

function resolveSkillGroup(skill: Skill): SkillGroupKey {
  if (!skill.id.startsWith('system_') && skill.id !== 'strict_grammar') return 'custom'
  if (['system_dictation', 'system_grammar', 'strict_grammar', 'system_rewrite'].includes(skill.id)) return 'core'
  if (['system_chat_reply', 'system_email_draft', 'system_domain_email', 'system_social_post'].includes(skill.id)) return 'communication'
  if (['system_issue_ticket', 'system_doc_notes', 'system_domain_structured_note', 'system_bullets'].includes(skill.id)) return 'structured'
  return 'code'
}

function SkillMetaCard({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
      <div className="text-[11px] uppercase tracking-[0.26em] text-text-muted">{label}</div>
      <div className="mt-2 text-sm text-text-primary">{value}</div>
    </div>
  )
}

export const SkillsManager = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [newPrompt, setNewPrompt] = useState('')
  const [newBestUsedIn, setNewBestUsedIn] = useState<TemplateFormDraft['best_used_in']>('generic')
  const [newTone, setNewTone] = useState<TemplateFormDraft['tone']>('automatic')
  const [newTriggers, setNewTriggers] = useState('')
  const [newTargetTypes, setNewTargetTypes] = useState('')
  const [newMaxChars, setNewMaxChars] = useState('')
  const [newPromptDetails, setNewPromptDetails] = useState('')
  const [newStyle, setNewStyle] = useState('')
  const [newFallbackBehavior, setNewFallbackBehavior] = useState('selected_skill')
  const [newOutputMode, setNewOutputMode] = useState<Skill['output_mode']>('plain_text')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; message: string } | null>(null)
  const [diagnostics, setDiagnostics] = useState<TemplatePackageDiagnostic[]>([])
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null)
  const [expandedSkill, setExpandedSkill] = useState<Skill | null>(null)
  const [showExpandedPrompt, setShowExpandedPrompt] = useState(false)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const triggerTags = parseCsvList(newTriggers)
  const targetTypeTags = parseCsvList(newTargetTypes)
  const prospectiveId = buildTemplateId(newName, newId, skills)
  const explicitIdCollision = Boolean(
    newId.trim() && skills.some((skill) => skill.id === sanitizeTemplateId(newId.trim())),
  )
  const autoIdCollision = Boolean(
    !newId.trim()
    && newName.trim()
    && prospectiveId !== `custom_${slugifyTemplateName(newName) || 'template'}`,
  )

  const syncExpandedSkillParam = useCallback((skillId: string | null) => {
    const nextParams = new URLSearchParams(searchParams)
    if (skillId) nextParams.set('id', skillId)
    else nextParams.delete('id')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  const resetForm = () => {
    setIsCreating(false)
    setNewId('')
    setNewName('')
    setNewPrompt('')
    setNewBestUsedIn('generic')
    setNewTone('automatic')
    setNewTriggers('')
    setNewTargetTypes('')
    setNewMaxChars('')
    setNewPromptDetails('')
    setNewStyle('')
    setNewFallbackBehavior('selected_skill')
    setNewOutputMode('plain_text')
    setShowAdvanced(false)
  }

  const startFromTemplate = useCallback((skill: Skill) => {
    const parsedPrompt = parseTemplatePrompt(skill.prompt)
    setIsCreating(true)
    setExpandedSkill(null)
    syncExpandedSkillParam(null)
    setNewId('')
    setNewName(`${skill.name} Copy`)
    setNewPrompt(parsedPrompt.purpose)
    setNewBestUsedIn((skill.target_types[0] as TemplateFormDraft['best_used_in']) || 'generic')
    setNewTone(
      skill.style === 'concise' || skill.style === 'professional' || skill.style === 'friendly'
        ? skill.style
        : 'automatic',
    )
    setNewTriggers(skill.triggers.join(', '))
    setNewTargetTypes(skill.target_types.join(', '))
    setNewMaxChars(skill.max_chars ? String(skill.max_chars) : '')
    setNewPromptDetails(parsedPrompt.advancedInstructions)
    setNewStyle(skill.style || '')
    setNewFallbackBehavior(skill.fallback_behavior || 'selected_skill')
    setNewOutputMode(skill.output_mode)
    setShowAdvanced(Boolean(skill.triggers.length || skill.target_types.length || skill.max_chars || skill.style || parsedPrompt.advancedInstructions))
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }, [syncExpandedSkillParam])

  useEffect(() => {
    fetchSkills()
  }, [])

  useEffect(() => {
    setShowExpandedPrompt(false)
  }, [expandedSkill])

  useEffect(() => {
    const requestedId = searchParams.get('id')
    if (!requestedId || !skills.length) return
    const requestedSkill = skills.find((skill) => skill.id === requestedId)
    if (requestedSkill) {
      setExpandedSkill(requestedSkill)
    }
  }, [searchParams, skills])

  const handleScroll = useCallback(() => {
    const nextTop = scrollContainerRef.current?.scrollTop || 0
    setShowBackToTop(nextTop > 520)
  }, [])

  const scrollToTop = useCallback(() => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const fetchSkills = async () => {
    setLoading(true)
    try {
      const [skillsRes, diagnosticsRes] = await Promise.all([
        apiGet<{ skills: Skill[] }>('/skills'),
        apiGet<{ items: TemplatePackageDiagnostic[] }>('/skills/diagnostics'),
      ])
      setSkills(skillsRes.data.skills || [])
      setDiagnostics(diagnosticsRes.data.items || [])
    } catch {
      setBanner({ tone: 'error', message: 'Failed to load the current template library.' })
    } finally {
      setLoading(false)
    }
  }

  const saveNewSkill = async () => {
    if (!newName || !newPrompt) return

    const nextId = buildTemplateId(newName, newId, skills)
    const nextPrompt = buildTemplatePrompt({
      whatItDoes: newPrompt,
      tone: newTone,
      outputMode: newOutputMode,
      promptDetails: newPromptDetails,
    })

    try {
      await apiPost('/skills', {
        id: nextId,
        name: newName,
        prompt: nextPrompt,
        triggers: parseCsvList(newTriggers),
        target_types: resolveDraftTargetTypes(newBestUsedIn, newTargetTypes),
        max_chars: newMaxChars ? Number(newMaxChars) : null,
        style: newStyle.trim() || resolveToneStyle(newTone),
        fallback_behavior: newFallbackBehavior.trim() || 'selected_skill',
        output_mode: newOutputMode,
      })
      resetForm()
      setBanner({ tone: 'success', message: `Saved "${newName}" as a reusable template.` })
      await fetchSkills()
    } catch (error: unknown) {
      setBanner({ tone: 'error', message: getErrorMessage(error, 'Failed to save the template. Review the advanced fields and try again.') })
    }
  }

  const deleteSkill = async () => {
    if (!pendingDelete) return

    try {
      await apiDelete(`/skills/${pendingDelete.id}`)
      setBanner({ tone: 'success', message: `Deleted "${pendingDelete.name}".` })
      setPendingDelete(null)
      await fetchSkills()
    } catch (error: unknown) {
      setBanner({ tone: 'error', message: getErrorMessage(error, 'Failed to delete that template.') })
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <BrandedProgressLoader
          title="Loading templates"
          subtitle="Loading saved and built-in templates."
        />
      </div>
    )
  }

  const builtInSkills = skills.filter((skill) => skill.id.startsWith('system_'))
  const customSkills = skills.filter((skill) => !skill.id.startsWith('system_'))
  const groupedBuiltIns = (Object.keys(SKILL_GROUP_META) as Array<Exclude<SkillGroupKey, 'custom'>>).map((groupKey) => ({
    key: groupKey,
    meta: SKILL_GROUP_META[groupKey],
    skills: builtInSkills.filter((skill) => resolveSkillGroup(skill) === groupKey),
  })).filter((group) => group.skills.length > 0)

  return (
    <div className="relative h-full">
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-8 py-6"
      >
        <div className="mx-auto max-w-6xl pb-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.3em] text-text-muted">Template library</div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-text-primary">Templates</h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-text-secondary">
              Choose the outcome you want Smart to produce for different apps and workflows.
            </p>
          </div>

          {!isCreating ? (
            <button
              onClick={() => setIsCreating(true)}
              className="inline-flex items-center gap-2 rounded-2xl border border-accent-primary/20 bg-accent-primary px-4 py-2.5 text-sm font-medium text-[#021318] transition-all hover:bg-[#46f0f4]"
            >
              <SparkIcon size={16} />
              New template
            </button>
          ) : null}
        </div>

        {banner ? <div className="mt-6"><Banner tone={banner.tone} message={banner.message} /></div> : null}
        {diagnostics.length ? (
          <div className="mt-6 space-y-2">
            <div className="text-[11px] uppercase tracking-[0.24em] text-text-muted">
              Template library notices
            </div>
            <ul className="space-y-2">
              {diagnostics.map((diagnostic, index) => {
                const isError = diagnostic.severity === 'error'
                const toneClass = isError
                  ? 'border-semantic-error/25 bg-semantic-error/10 text-semantic-error'
                  : 'border-semantic-warning/20 bg-semantic-warning/8 text-text-secondary'
                return (
                  <li
                    key={`${diagnostic.id ?? 'unknown'}-${index}`}
                    className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${toneClass}`}
                  >
                    <div className="font-medium">
                      {isError ? 'Error' : 'Warning'}
                      {diagnostic.id ? ` — ${diagnostic.id}` : ''}
                    </div>
                    <div className="mt-1">{diagnostic.message}</div>
                    {diagnostic.package_path ? (
                      <div className="mt-1 text-[11px] text-text-muted">{diagnostic.package_path}</div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            <div className="text-[11px] text-text-muted">
              SKILL.md packages live under {APP_HOME_DISPLAY_PATH}/skills.
            </div>
          </div>
        ) : null}

        {isCreating ? (
          <section className="mt-6 rounded-[28px] border border-accent-primary/18 bg-[linear-gradient(180deg,rgba(9,27,38,0.82),rgba(4,13,20,0.92))] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.26)]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">New custom template</div>
                <h2 className="mt-2 text-xl font-semibold text-text-primary">Create a custom template</h2>
              </div>
              <button
                onClick={resetForm}
                className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-text-muted transition-all hover:bg-white/[0.06] hover:text-text-primary"
                title="Close"
              >
                <WindowCloseIcon size={14} />
              </button>
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-2">
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Template name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="e.g. Browser Brief"
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                />
                {newName.trim() ? (
                  <div className="mt-2 text-[11px] leading-5 text-text-muted">
                    Will save as <span className="font-mono text-text-secondary">{prospectiveId}</span>
                    {autoIdCollision ? (
                      <span className="ml-1 text-semantic-warning">
                        — a template with that slug already exists, so this will be suffixed automatically. Set a Raw ID in Advanced to rename.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="rounded-2xl border border-white/6 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-text-secondary">
                IDs are generated automatically from the template name. Open Advanced only when you need to override the defaults.
              </div>
            </div>

            <div className="mt-5">
              <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">What should it do?</label>
              <textarea
                rows={6}
                value={newPrompt}
                onChange={(event) => setNewPrompt(event.target.value)}
                placeholder="Turn the transcript into a concise teammate update with clear next steps."
                className="w-full resize-none rounded-[24px] border border-white/8 bg-black/30 px-4 py-4 text-sm leading-7 text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
              />
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-3">
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Best used in</label>
                <select
                  value={newBestUsedIn}
                  onChange={(event) => setNewBestUsedIn(event.target.value as TemplateFormDraft['best_used_in'])}
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                >
                  <option value="generic">Any app</option>
                  <option value="chat">Chat</option>
                  <option value="browser_doc">Document</option>
                  <option value="ide">Code</option>
                  <option value="social_post">Social post</option>
                </select>
              </div>
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Tone</label>
                <select
                  value={newTone}
                  onChange={(event) => setNewTone(event.target.value as TemplateFormDraft['tone'])}
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                >
                  <option value="automatic">Automatic</option>
                  <option value="concise">Concise</option>
                  <option value="professional">Professional</option>
                  <option value="friendly">Friendly</option>
                </select>
              </div>
              <div>
                <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Output</label>
                <select
                  value={newOutputMode}
                  onChange={(event) => setNewOutputMode(event.target.value as Skill['output_mode'])}
                  className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                >
                  <option value="plain_text">Plain text</option>
                  <option value="bullets">Bullets</option>
                  <option value="command">Command</option>
                  <option value="code">Code</option>
                </select>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] p-4 text-sm leading-7 text-text-secondary">
              Describe only the final output you want. Transcript and context are still added automatically at runtime.
            </div>

            <div className="mt-5 rounded-2xl border border-white/6 bg-white/[0.02] p-4">
              <button
                type="button"
                onClick={() => setShowAdvanced((current) => !current)}
                className="flex w-full items-center justify-between text-sm font-semibold text-text-primary outline-none"
              >
                Advanced
                <ArrowRightIcon size={14} className={`transition-transform duration-200 ${showAdvanced ? 'rotate-90' : 'rotate-0'}`} />
              </button>

              <AnimatePresence initial={false}>
                {showAdvanced ? (
                  <motion.div
                    initial={{ height: 0, opacity: 0, marginTop: 0 }}
                    animate={{ height: 'auto', opacity: 1, marginTop: 16 }}
                    exit={{ height: 0, opacity: 0, marginTop: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="grid gap-5 lg:grid-cols-2">
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Raw ID</label>
                  <input
                    type="text"
                    value={newId}
                    onChange={(event) => setNewId(sanitizeTemplateId(event.target.value))}
                    placeholder="Optional override"
                    className={`w-full rounded-2xl border bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:ring-2 ${
                      explicitIdCollision
                        ? 'border-semantic-warning/40 focus:border-semantic-warning/50 focus:ring-semantic-warning/20'
                        : 'border-white/8 focus:border-accent-primary/30 focus:ring-accent-primary/20'
                    }`}
                  />
                  {explicitIdCollision ? (
                    <div className="mt-2 text-[11px] leading-5 text-semantic-warning">
                      A template with this ID already exists. Pick a different ID or clear the field to auto-generate one.
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Triggers</label>
                  <input
                    type="text"
                    value={newTriggers}
                    onChange={(event) => setNewTriggers(event.target.value)}
                    placeholder="slack, discord, gmail"
                    className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  />
                  {triggerTags.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {triggerTags.map((tag) => (
                        <span key={tag} className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[10px] text-text-secondary">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Target types</label>
                  <input
                    type="text"
                    value={newTargetTypes}
                    onChange={(event) => setNewTargetTypes(event.target.value)}
                    placeholder="chat, generic, ide"
                    className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  />
                  {targetTypeTags.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {targetTypeTags.map((tag) => (
                        <span key={tag} className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[10px] text-text-secondary">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Prompt details</label>
                  <textarea
                    rows={4}
                    value={newPromptDetails}
                    onChange={(event) => setNewPromptDetails(event.target.value)}
                    placeholder="Optional extra constraints, examples, or formatting notes."
                    className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  />
                </div>
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Max chars</label>
                  <input
                    type="number"
                    min={1}
                    value={newMaxChars}
                    onChange={(event) => setNewMaxChars(event.target.value)}
                    placeholder="Optional limit"
                    className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  />
                </div>
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Style</label>
                  <input
                    type="text"
                    value={newStyle}
                    onChange={(event) => setNewStyle(event.target.value)}
                    placeholder="concise_professional"
                    className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  />
                </div>
                <div>
                  <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.24em] text-text-muted">Fallback behavior</label>
                  <input
                    type="text"
                    value={newFallbackBehavior}
                    onChange={(event) => setNewFallbackBehavior(event.target.value)}
                    placeholder="selected_skill, raw_dictation, system_dictation"
                    className="w-full rounded-2xl border border-white/8 bg-black/30 px-4 py-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary/30 focus:ring-2 focus:ring-accent-primary/20"
                  />
                </div>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={saveNewSkill}
                disabled={!newName || !newPrompt || explicitIdCollision}
                className="inline-flex items-center gap-2 rounded-2xl border border-accent-primary/20 bg-accent-primary px-5 py-2.5 text-sm font-medium text-[#021318] transition-all hover:bg-[#46f0f4] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <SparkIcon size={16} />
                Save template
              </button>
            </div>
          </section>
        ) : null}

        <div className="mt-6 space-y-8">
          {groupedBuiltIns.map((group) => (
            <section key={group.key}>
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">{group.meta.label}</div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">{group.meta.description}</p>
                </div>
                <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">
                  {group.skills.length} template{group.skills.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                {group.skills.map((skill) => (
                  <article
                    key={skill.id}
                    className="group glass-card relative overflow-hidden p-5 transition-all hover:border-accent-primary/14 hover:shadow-[0_16px_36px_rgba(0,0,0,0.2)]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-text-primary">{skill.name}</h3>
                          <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">
                            Built in
                          </span>
                        </div>
                        {skill.description ? (
                          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">{skill.description}</p>
                        ) : (
                          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">Built to shape Smart output for a common workflow.</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedSkill(skill)
                          syncExpandedSkillParam(skill.id)
                        }}
                        className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.06]"
                      >
                        View details
                      </button>
                      <button
                        type="button"
                        onClick={() => startFromTemplate(skill)}
                        className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.06]"
                      >
                        Use as custom
                      </button>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-secondary">
                        Best for {resolveTemplateSurface(skill)}
                      </span>
                      <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-secondary">
                        {formatOutputMode(skill.output_mode)}
                      </span>
                    </div>
                    <p className="mt-4 text-sm leading-6 text-text-secondary">{resolveTemplateExample(skill)}</p>
                  </article>
                ))}
              </div>
            </section>
          ))}

          <section>
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.28em] text-text-muted">Custom templates</div>
                <p className="mt-2 text-sm leading-6 text-text-secondary">Your own Smart templates for app-specific writing and formatting.</p>
              </div>
              <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">
                {customSkills.length} saved
              </span>
            </div>
            {customSkills.length ? (
              <div className="grid gap-5 lg:grid-cols-2">
                {customSkills.map((skill) => (
                  <article
                    key={skill.id}
                    className="group glass-card relative overflow-hidden p-5 transition-all hover:border-accent-primary/14 hover:shadow-[0_16px_36px_rgba(0,0,0,0.2)]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-text-primary">{skill.name}</h3>
                          <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">
                            Custom
                          </span>
                        </div>
                        {skill.description ? (
                          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">{skill.description}</p>
                        ) : (
                          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">Uses your custom instructions and optional advanced rules.</p>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedSkill(skill)
                            syncExpandedSkillParam(skill.id)
                          }}
                          className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.06]"
                        >
                          View details
                        </button>
                        <button
                          onClick={() => setPendingDelete(skill)}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-text-muted opacity-0 transition-all hover:border-semantic-error/20 hover:bg-semantic-error/12 hover:text-semantic-error group-hover:opacity-100"
                          title={`Delete ${skill.name}`}
                        >
                          <ErrorIcon size={14} />
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-secondary">
                        Best for {resolveTemplateSurface(skill)}
                      </span>
                      <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[11px] text-text-secondary">
                        {formatOutputMode(skill.output_mode)}
                      </span>
                    </div>
                    <p className="mt-4 text-sm leading-6 text-text-secondary">{resolveTemplateExample(skill)}</p>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-text-secondary">
                No custom templates yet. Use <span className="text-text-primary">New template</span> only if the built-in templates do not already fit the workflow.
              </div>
            )}
          </section>
        </div>
        </div>
      </div>

      {showBackToTop ? (
        <button
          type="button"
          onClick={scrollToTop}
          className="absolute bottom-7 right-7 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-[linear-gradient(180deg,rgba(32,35,43,0.95),rgba(20,22,28,0.88))] text-text-primary shadow-[0_18px_30px_rgba(0,0,0,0.28)] backdrop-blur-xl transition-all hover:-translate-y-0.5 hover:bg-[linear-gradient(180deg,rgba(44,48,58,0.96),rgba(24,27,33,0.9))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141a]"
          title="Back to top"
          aria-label="Back to top"
        >
          <ArrowRightIcon size={16} className="-rotate-90" />
        </button>
      ) : null}

      {expandedSkill ? (
        <div
          className="absolute inset-0 flex items-center justify-center bg-[rgba(2,8,12,0.74)] px-6 backdrop-blur-md"
          onClick={() => {
            setExpandedSkill(null)
            syncExpandedSkillParam(null)
          }}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(24,28,36,0.96),rgba(11,13,18,0.98))] shadow-[0_18px_50px_rgba(0,0,0,0.3)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-white/6 px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-text-primary">{expandedSkill.name}</h2>
                  <span className="rounded-full border border-white/8 bg-white/[0.04] px-2.5 py-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">
                    {expandedSkill.id.startsWith('system_') ? 'Built in' : 'Custom'}
                  </span>
                </div>
                {expandedSkill.description ? (
                  <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">{expandedSkill.description}</p>
                ) : (
                  <p className="mt-2 text-sm leading-6 text-text-secondary">This template shapes how Smart produces the final output.</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setExpandedSkill(null)
                  syncExpandedSkillParam(null)
                }}
                className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-white/8 bg-white/[0.03] text-text-muted transition-all hover:bg-white/[0.06] hover:text-text-primary"
                title="Close"
              >
                <WindowCloseIcon size={14} />
              </button>
            </div>
            </div>
            <div className="max-h-[72vh] overflow-y-auto px-6 py-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <SkillMetaCard label="Output" value={formatOutputMode(expandedSkill.output_mode)} />
                <SkillMetaCard label="Fallback" value={formatFallbackBehavior(expandedSkill.fallback_behavior)} />
                <SkillMetaCard label="Style" value={expandedSkill.style ? formatToken(expandedSkill.style) : 'Automatic'} />
                <SkillMetaCard
                  label="Triggers"
                  value={expandedSkill.triggers.length ? expandedSkill.triggers.map((entry) => formatToken(entry)).join(', ') : 'No trigger filter'}
                />
                <SkillMetaCard
                  label="Targets"
                  value={expandedSkill.target_types.length ? expandedSkill.target_types.map((entry) => formatTargetTypeLabel(entry)).join(', ') : 'Any app'}
                />
                <SkillMetaCard label="Length" value={expandedSkill.max_chars ? `${expandedSkill.max_chars} characters` : 'No limit'} />
              </div>

              <div className="mt-4 rounded-2xl border border-white/6 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-text-primary">Template instructions</div>
                    <p className="mt-1.5 text-sm leading-6 text-text-secondary">
                      Hidden by default so this view stays easy to scan.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => startFromTemplate(expandedSkill)}
                      className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.06]"
                    >
                      Use as custom template
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowExpandedPrompt((current) => !current)}
                      className="rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-white/[0.06]"
                    >
                      {showExpandedPrompt ? 'Hide instructions' : 'Show instructions'}
                    </button>
                  </div>
                </div>
                {showExpandedPrompt ? (
                  <div className="mt-4 rounded-2xl border border-white/6 bg-black/30 p-4">
                    <pre className="max-h-[38vh] overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-text-secondary">{expandedSkill.prompt}</pre>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[rgba(2,8,12,0.7)] px-6 backdrop-blur-md">
          <div className="w-full max-w-md rounded-[28px] border border-semantic-error/20 bg-[linear-gradient(180deg,rgba(27,11,16,0.94),rgba(8,8,11,0.98))] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.3)]">
            <div className="flex items-center gap-3 text-semantic-error">
              <ErrorIcon size={18} />
              <h2 className="text-lg font-semibold text-text-primary">Delete custom template?</h2>
            </div>
            <p className="mt-4 text-sm leading-7 text-text-secondary">
              <strong className="text-text-primary">{pendingDelete.name}</strong> will be removed from the template library. Built-in templates cannot be restored from here.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setPendingDelete(null)}
                className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-text-primary transition-all hover:bg-white/[0.06]"
              >
                Cancel
              </button>
              <button
                onClick={deleteSkill}
                className="rounded-2xl border border-semantic-error/20 bg-semantic-error px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-[#ff6d7a]"
              >
                Delete template
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
