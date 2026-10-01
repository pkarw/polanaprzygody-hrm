import React from 'react'
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components'

export type VisitPaymentLinkEmailCopy = {
  preview: string
  heading: string
  greeting: string
  body: string
  cta: string
  securityHint: string
  footer: string
}

// Email clients require inline CSS and do not load the application's design-token
// stylesheet. Keeping the brand styles in one typed map makes that exception explicit
// and prevents the backend UI from inheriting any hard-coded presentation values.
const emailStyleProps = {
  body: { style: { backgroundColor: '#f7f7ef', fontFamily: 'Helvetica, Arial, sans-serif', padding: '24px 0' } },
  container: { style: { backgroundColor: '#ffffff', borderRadius: '16px', margin: '0 auto', maxWidth: '560px', padding: '32px' } },
  heading: { style: { color: '#2a5c47', fontSize: '24px', fontWeight: 600, margin: '0 0 16px' } },
  text: { style: { color: '#26352f', fontSize: '16px', lineHeight: '24px' } },
  ctaSection: { style: { margin: '28px 0', textAlign: 'center' as const } },
  cta: {
    style: {
      backgroundColor: '#2a5c47',
      borderRadius: '10px',
      color: '#ffffff',
      display: 'inline-block',
      fontSize: '16px',
      padding: '13px 24px',
      textDecoration: 'none',
    },
  },
  hint: { style: { color: '#59645f', fontSize: '13px', lineHeight: '20px' } },
  divider: { style: { borderColor: '#e2e7e3', margin: '24px 0' } },
  footer: { style: { color: '#77817c', fontSize: '12px', lineHeight: '18px' } },
}

export default function VisitPaymentLinkEmail({
  paymentUrl,
  copy,
}: {
  paymentUrl: string
  copy: VisitPaymentLinkEmailCopy
}) {
  return (
    <Html>
      <Head><title>{copy.heading}</title></Head>
      <Preview>{copy.preview}</Preview>
      <Body {...emailStyleProps.body}>
        <Container {...emailStyleProps.container}>
          <Heading {...emailStyleProps.heading}>
            {copy.heading}
          </Heading>
          <Text {...emailStyleProps.text}>{copy.greeting}</Text>
          <Text {...emailStyleProps.text}>{copy.body}</Text>
          <Section {...emailStyleProps.ctaSection}>
            <Button
              href={paymentUrl}
              {...emailStyleProps.cta}
            >
              {copy.cta}
            </Button>
          </Section>
          <Text {...emailStyleProps.hint}>{copy.securityHint}</Text>
          <Hr {...emailStyleProps.divider} />
          <Text {...emailStyleProps.footer}>{copy.footer}</Text>
        </Container>
      </Body>
    </Html>
  )
}
