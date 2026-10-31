/**
 * The site lists' layout switch: List or Grid, a radio group drawn as a segmented control. Native
 * radios, so arrow keys move between them and screen readers announce a group of two; the labels
 * are icons with their names for screen readers and in a tooltip. Drawn as one box like the sort
 * select beside it (`.layout-toggle` in theme.css), the chosen option tinted.
 */
import { ListBulletIcon, Squares2X2Icon } from '@heroicons/react/24/outline'
import { SITES_LAYOUTS, type SitesLayout } from '../lib/sites'

const OPTIONS: Record<SitesLayout, { label: string; Icon: typeof ListBulletIcon }> = {
  list: { label: 'List', Icon: ListBulletIcon },
  grid: { label: 'Grid', Icon: Squares2X2Icon },
}

export function SitesLayoutToggle({
  value,
  onChange,
}: {
  value: SitesLayout
  onChange: (layout: SitesLayout) => void
}) {
  return (
    <fieldset className="layout-toggle shrink-0">
      <legend className="sr-only">Show sites as</legend>
      {SITES_LAYOUTS.map(layout => {
        const { label, Icon } = OPTIONS[layout]
        return (
          <label key={layout} title={label}>
            <input
              type="radio"
              name="sites-layout"
              value={layout}
              checked={value === layout}
              onChange={() => onChange(layout)}
              className="sr-only"
            />
            <Icon className="h-4 w-4" aria-hidden />
            <span className="sr-only">{label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}
