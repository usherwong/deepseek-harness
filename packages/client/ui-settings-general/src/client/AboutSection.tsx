/** The About section: product name and the desktop app version from the Host. */
import { useEffect, useState } from 'react'
import type { SettingsKey } from './locales.ts'
import css from './AboutSection.module.css'

/** Injected props: a version loader and the bound settings translate. */
export interface AboutSectionInjected {
  loadVersion: () => Promise<string>
  t: (key: SettingsKey) => string
}

/**
 * Render the About section. The version is the desktop app's own version,
 * reported live by `workspace.version` — the shell exports it as
 * `DSH_DESKTOP_VERSION`, and the bare CLI falls back to the harness version.
 */
export function AboutSection({ loadVersion, t }: AboutSectionInjected) {
  const [version, setVersion] = useState<string | undefined>(undefined)
  useEffect(() => {
    let stale = false
    void loadVersion().then((next) => {
      if (!stale) setVersion(next)
    }, () => undefined)
    return () => { stale = true }
  }, [loadVersion])
  return (
    <div className={css.section}>
      <div className={css.product}>{t('about.product')}</div>
      <div className={css.version}>{t('about.versionPrefix')}{version ?? '…'}</div>
    </div>
  )
}
