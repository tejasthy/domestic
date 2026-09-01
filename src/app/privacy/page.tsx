import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section, List } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Privacy Policy — Domestic',
  description:
    'What Domestic stores, who it shares it with, and how to get it deleted.',
};

const REPO = 'https://github.com/tejasthy/domestic';
const ISSUES = `${REPO}/issues`;

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="September 1, 2026"
      intro={
        <>
          Domestic is a chore and shared-expense tracker for households. It is a
          small, self-funded project, not an advertising business — it holds the
          least it can get away with, and none of it is sold.
        </>
      }
    >
      <Section heading="Who this policy covers">
        <p>
          This policy covers the version of Domestic hosted at this domain. The
          source code is{' '}
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            published under the MIT license
          </a>
          , so anyone is free to run their own copy. If you are using someone
          else&rsquo;s deployment, they control that database and this policy
          does not describe it — ask them.
        </p>
      </Section>

      <Section heading="What is collected">
        <p>Only what the app needs to work:</p>
        <List
          items={[
            <>
              <strong>Your account</strong> — name, email address, and the
              profile picture and initials shown next to your chores. These come
              from whichever sign-in method you chose.
            </>,
            <>
              <strong>Your household</strong> — its name, its time zone, and an
              optional street address used to place the kiosk&rsquo;s weather.
            </>,
            <>
              <strong>Chores</strong> — the rotation, whose turn it is, and the
              history of completed, skipped, and swapped turns.
            </>,
            <>
              <strong>Shared costs</strong> — amounts, descriptions, categories,
              line items, how each is split, and any note or receipt link you
              add yourself.
            </>,
            <>
              <strong>Notification settings</strong> — your quiet hours, and, if
              you turn on push notifications, the subscription your browser
              issues along with the browser and device name it reports.
            </>,
            <>
              <strong>Wall displays</strong> — a name for each paired tablet and
              when it last checked in. Pairing tokens are stored only as a hash,
              never in a form that can be read back.
            </>,
          ]}
        />
        <p>
          There is no tracking pixel, no advertising identifier, and no
          third-party profile built about you.
        </p>
      </Section>

      <Section heading="Who can see it">
        <p>
          <strong>Everyone in your household can see everything in it.</strong>{' '}
          That is the point of the app — the rotation, the ledger, and who owes
          what are shared by design. Do not put anything in a note or an expense
          description that you would not want your roommates to read.
        </p>
        <p>
          Households are isolated from one another at the database level. Every
          table enforces membership on every read and write, so another
          household cannot query yours even by accident.
        </p>
      </Section>

      <Section heading="Services it relies on">
        <p>
          Domestic hands data to a small number of providers in order to run.
          Each one gets only what its job requires:
        </p>
        <List
          items={[
            <>
              <strong>Supabase</strong> — hosts the database and handles
              sign-in. Everything listed above lives here.
            </>,
            <>
              <strong>Vercel</strong> — hosts the app and keeps ordinary server
              request logs, including IP addresses, for a short period.
            </>,
            <>
              <strong>Google</strong> — verifies your identity if you sign in
              with Google, and returns address suggestions as you type your
              household&rsquo;s address. If this deployment has analytics turned
              on, Google Analytics also receives standard page-view data.
            </>,
            <>
              <strong>Cloudflare</strong> — runs the bot check on the sign-in
              page.
            </>,
            <>
              <strong>Anthropic or Google</strong> — reads receipt photographs,
              but only if an admin of your household has supplied an API key for
              one of them. See below.
            </>,
            <>
              <strong>Open-Meteo</strong> — returns the kiosk forecast. It
              receives approximate coordinates for the household, never anything
              about a person.
            </>,
            <>
              <strong>Apple, Google, and Mozilla</strong> — deliver push
              notifications to whichever browser you subscribed with.
            </>,
          ]}
        />
      </Section>

      <Section heading="Receipt photographs">
        <p>
          When you scan a receipt, the image is sent to the AI provider your
          household configured, read once, and turned into line items.{' '}
          <strong>Domestic does not store the photograph.</strong> It is held in
          memory for the length of that single request and then discarded — only
          the text pulled out of it is saved to your expense.
        </p>
        <p>
          What the provider does with the image afterward is governed by their
          terms, not this policy, and depends on the API key your admin used.
          Receipt scanning is off entirely until an admin adds a key.
        </p>
      </Section>

      <Section heading="Cookies">
        <p>
          Domestic sets a cookie to keep you signed in and one to remember
          whether you chose light or dark mode. Neither is used to track you
          across other sites. If analytics is enabled on this deployment, Google
          Analytics sets its own cookies; blocking them does not affect the app.
        </p>
      </Section>

      <Section heading="How long it is kept">
        <p>
          Your data stays as long as your household does. Completed chore turns
          and settled expenses are deliberately kept as history — the ledger
          would not add up otherwise.
        </p>
        <p>
          A household admin can remove a member at any time from Settings. To
          have your account and personal data deleted outright, open an issue at{' '}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            github.com/tejasthy/domestic/issues
          </a>
          . There is no self-service delete button yet.
        </p>
      </Section>

      <Section heading="Your choices">
        <List
          items={[
            <>Edit your name, initials, color, and notification settings in Settings at any time.</>,
            <>Turn push notifications off, from Settings or from your browser.</>,
            <>Ask for a copy of your data, or ask for it to be deleted, via the link above.</>,
            <>Run your own copy of Domestic instead, if you would rather nobody else host it.</>,
          ]}
        />
      </Section>

      <Section heading="Security">
        <p>
          Traffic is encrypted in transit. Access is enforced in the database
          itself rather than only in application code, so a bug in a page cannot
          hand you another household&rsquo;s rows. Wall-display pairing tokens
          are stored as hashes, and any AI provider key an admin adds is
          encrypted at rest and unreadable to the app&rsquo;s normal query
          paths.
        </p>
        <p>
          No system is perfectly secure, and this one is maintained by one
          person. Please do not store anything in Domestic that would be
          genuinely damaging to lose or expose.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          Domestic is not directed at children under 13 and accounts should not
          be created for them.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If this policy changes in a way that matters, the date at the top will
          change and the change will be visible in the project&rsquo;s public
          commit history.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions, data requests, and anything that looks like a security
          problem:{' '}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            open an issue on GitHub
          </a>
          . For a security report, please avoid including details that would
          help someone else exploit it.
        </p>
        <p>
          See also the <Link href="/terms">Terms of Service</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
