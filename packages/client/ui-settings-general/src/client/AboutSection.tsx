/** The About section: product name and the desktop app version from the Host. */
import { useEffect, useState } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsKey } from './locales.ts'
import css from './AboutSection.module.css'

/** Injected props: the Host API face and the bound settings translate. */
export interface AboutSectionInjected {
  api: IApiClient
  t: (key: SettingsKey) => string
}

/**
 * Render the About section. The version is the desktop app's own version,
 * reported live by `host.describe` — the shell exports it as
 * `DSH_DESKTOP_VERSION`, and the bare CLI falls back to the harness version.
 */
export function AboutSection({ api, t }: AboutSectionInjected) {
  const [version, setVersion] = useState<string | undefined>(undefined)
  useEffect(() => {
    let stale = false
    void api.host.describe({}).then((response) => {
      if (!stale && response.result.ok) setVersion(response.result.value.version)
    }, () => undefined)
    return () => { stale = true }
  }, [api])
  return (
    <div className={css.section}>
      <div className={css.product}>{t('about.product')}</div>
      <div className={css.version}>{t('about.versionPrefix')}{version ?? '…'}</div>
    </div>
  )
}
