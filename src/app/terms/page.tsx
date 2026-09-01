import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, Section, List } from '@/components/legal';

export const metadata: Metadata = {
  title: 'Terms of Service — Domestic',
  description:
    'The terms for using Domestic: free, as-is, not a payment service, and yours to leave whenever.',
};

const REPO = 'https://github.com/tejasthy/domestic';
const ISSUES = `${REPO}/issues`;

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="September 1, 2026"
      intro={
        <>
          Domestic is free, run by one person, and provided as-is. These terms
          are short on purpose. Using the app means you accept them.
        </>
      }
    >
      <Section heading="What Domestic is">
        <p>
          A tool for a household to track whose turn it is and who paid for
          what. It is a record of what you and your roommates tell it — nothing
          more.
        </p>
        <p>
          These terms cover the version hosted at this domain. The code itself
          is{' '}
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            MIT-licensed
          </a>{' '}
          and you are welcome to run your own copy — these terms govern this
          deployment, the license governs the code.
        </p>
      </Section>

      <Section heading="It does not move money">
        <p>
          <strong>
            Domestic is not a bank, a payment processor, or a financial service.
          </strong>{' '}
          It calculates who owes whom and suggests the fewest transfers that
          would settle up. It does not hold funds, transfer them, or verify that
          anyone actually paid. Settling up happens between you and your
          roommates, by whatever means you already use.
        </p>
        <p>
          Nothing in the app is financial, tax, or legal advice, and a balance
          shown in Domestic is not a legally binding debt.
        </p>
      </Section>

      <Section heading="Your account">
        <List
          items={[
            <>Keep your sign-in secure, and use an email address you actually control.</>,
            <>
              You are responsible for what happens under your account, including
              anything a roommate does if you hand them your device.
            </>,
            <>
              Household admins can invite people, remove them, and change
              household settings. Choose your admins accordingly.
            </>,
            <>You must be old enough to enter a contract where you live, and at least 13.</>,
          ]}
        />
      </Section>

      <Section heading="Your content">
        <p>
          The chores, expenses, notes, and everything else you enter stay yours.
          You grant only the permission needed to run the service — storing your
          content, showing it to the other members of your household, and
          processing it to produce the features you asked for, such as reading a
          receipt you chose to scan.
        </p>
        <p>
          Do not put content in Domestic that is unlawful, that infringes
          someone else&rsquo;s rights, or that you do not have permission to
          share with your household.
        </p>
      </Section>

      <Section heading="Fair use">
        <p>Please do not:</p>
        <List
          items={[
            <>Try to reach another household&rsquo;s data, or probe for a way to.</>,
            <>Automate the app in a way that degrades it for everyone else.</>,
            <>Resell access, or run a commercial service on top of this deployment.</>,
            <>Use it to harass anyone, including the people you live with.</>,
          ]}
        />
        <p>
          Security research is welcome — report what you find rather than
          exploiting it, via{' '}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            an issue on GitHub
          </a>
          .
        </p>
      </Section>

      <Section heading="Receipt scanning is a guess">
        <p>
          Receipt scanning uses an AI model, and models misread things. Totals,
          line items, dates, and categories it produces are a starting point
          that you are expected to check before saving. Domestic is not
          responsible for a split that came out wrong because a number was
          misread and nobody looked.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          There is no uptime guarantee. Features can change or disappear, and
          the service can be discontinued. If it is ever shut down for good,
          there will be reasonable notice and a way to export your data — but
          keep your own records of anything that matters.
        </p>
      </Section>

      <Section heading="Ending it">
        <p>
          You can stop using Domestic whenever you like; see the{' '}
          <Link href="/privacy">Privacy Policy</Link> for how to have your data
          deleted. Access may be suspended for anyone who breaks the fair-use
          terms above or puts other households at risk.
        </p>
      </Section>

      <Section heading="No warranty">
        <p>
          Domestic is provided &ldquo;as is&rdquo; and &ldquo;as
          available,&rdquo; without warranties of any kind, express or implied,
          including merchantability, fitness for a particular purpose, and
          non-infringement. It is not guaranteed to be uninterrupted,
          error-free, or accurate.
        </p>
      </Section>

      <Section heading="Limitation of liability">
        <p>
          To the fullest extent the law allows, the maintainer of Domestic is
          not liable for any indirect, incidental, or consequential damages, or
          for lost data, lost money, or a disagreement between roommates arising
          out of your use of the app. Because the service is free, total
          liability for any claim is limited to the amount you paid for it,
          which is nothing.
        </p>
        <p>
          Some jurisdictions do not allow these exclusions, in which case they
          apply only as far as they legally can.
        </p>
      </Section>

      <Section heading="Changes to these terms">
        <p>
          These terms can change. The date at the top will change with them, and
          continuing to use the app after that means you accept the new version.
        </p>
      </Section>

      <Section heading="Governing law">
        <p>
          These terms are governed by the laws of the State of Michigan, USA,
          without regard to its conflict-of-laws rules.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions about these terms:{' '}
          <a href={ISSUES} target="_blank" rel="noopener noreferrer">
            open an issue on GitHub
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
