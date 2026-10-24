# Kareer design notes

What the public site should look and sound like. Read this before touching
`index.html`, `style.css`, `i18n.js` or any customer-facing page.

## The idea

Kareer sells something people are suspicious of: LinkedIn Premium for a lot
less than LinkedIn charges, paid over WhatsApp. The site's job is to look like
a small, real shop that tells you exactly what happens, not like a startup
template.

So the page is built like a price sheet. A cool off-white background tinted
toward the logo blue, black ink,
one blue taken from the logo, hairline rules between sections, prices set in
a monospace face so they read like a receipt. No gradients, glows, particles,
loaders, counters or scroll effects.

References we looked at for tone: Mullvad (one plain price, frank copy),
Basecamp's pricing page (opinionated sentences, no fluff), and printed shop
tariffs and till receipts for the price layout.

## Tokens

All colors live as custom properties on `:root` in `style.css`. Dark mode
follows `prefers-color-scheme` and only swaps the tokens.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#EEF1F4` | `#121314` | page background |
| `--paper-2` | `#E4E8EE` | `#18191B` | alternate band |
| `--card` | `#FFFFFF` | `#1C1D20` | receipt, panels |
| `--ink` | `#16181B` | `#EDEAE3` | main text |
| `--ink-2` | `#4B5058` | `#B3AFA7` | secondary text |
| `--ink-3` | `#6B717A` | `#86837D` | captions, struck prices |
| `--rule` | `#CBD2DB` | `#2D2F33` | hairlines, borders |
| `--blue` | `#1B4DB8` | `#86A6FF` | brand, primary buttons, links |
| `--blue-ink` | `#133A8C` | `#A9C0FF` | hover |
| `--mark` | `#FFE36E` | `#4A3F0A` | highlighter behind savings |
| `--wa` | `#1E7A4C` | `#4CC38A` | WhatsApp actions only |

Type:

- **Schibsted Grotesk** (400, 500, 700, 800) for everything with words.
- **IBM Plex Mono** (400, 500, 600) for prices, order numbers and small
  labels.
- Body 17px / 1.55. Headings tight (`letter-spacing: -0.02em` to `-0.035em`).
- Never Inter, never all-caps paragraphs, never gradient text.

Spacing runs on a 4px base. Sections are separated by a 1px `--rule` line and
`clamp(64px, 9vw, 120px)` of padding. Radius is 6px on buttons and inputs,
10px on panels. The only shadow is on the receipt card.

## Components

- **Header**: logo and wordmark, four text links, language as plain codes
  (`FR EN ES DE`, no flags), one small "Commander" button. On mobile the links
  fold into a `<details>` menu.
- **Receipt**: the hero's right column. One real example (Business, salaried
  price) with the LinkedIn price, the Kareer price and the difference.
  Perforated edge drawn with a CSS radial gradient.
- **Price list**: rows, not glowing cards. Each row has the plan, who it is
  for, what is included, the struck LinkedIn price, the Kareer price and a
  button. The student / salaried switch is a two-button segmented control
  with `aria-pressed`.
- **Steps**: an ordered list with a thin vertical rule. Each step says what
  the customer does and what we do.
- **FAQ**: native `<details>`. No JavaScript.
- **Buttons**: solid blue for the main action, outlined ink for the rest,
  green only when the button opens WhatsApp.

## Writing rules

These apply to every language.

- Say what happens, with numbers. "Actif sous 24 à 48 h" beats "activation
  ultra-rapide".
- No em dashes. Use a comma, a colon, a period or parentheses.
- Do not default to lists of three. Use the number of items the content has.
- No bullet lists with bold lead-ins ("**Rapide** : ...").
- No hype or filler: imbattable, booster, niveau supérieur, révolutionnaire,
  en toute sérénité, seamless, unlock, elevate, game-changer, "et bien plus".
- No closing slogans or rhetorical CTAs ("Prêt à passer au niveau
  supérieur ?"). End a section when the information ends.
- No emoji in interface copy.
- Only real numbers. No customer counters, star ratings or testimonials
  unless they come from real, verifiable reviews. No countdowns.
- Payment is on WhatsApp. Never say "paiement par carte sur le site".
- Always keep the line that Kareer is not affiliated with LinkedIn.

## Prices

Plan data lives in three places that must agree: `api/_plans.js` (source of
truth for what an order costs), the `PLANS` table in `checkout.html`, and the
price list in `index.html`. Official LinkedIn prices are the public France
annual-billing rates: Career 29,99 €/mois, Business 55 €/mois, Sales
Navigator Core 89,99 €/mois, Recruiter Lite 123,96 €/mois.
