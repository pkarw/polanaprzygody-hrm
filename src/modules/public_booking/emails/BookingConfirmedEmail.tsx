import React from 'react'
import { Body, Container, Head, Heading, Hr, Html, Preview, Section, Text } from '@react-email/components'

export type BookingConfirmedEmailCopy = {
  preview: string
  heading: string
  greeting: string
  body: string
  serviceLabel: string
  dateLabel: string
  timeLabel: string
  roomLabel: string
  addressLabel: string
  footer: string
}

const styles = {
  body: { style: { backgroundColor: '#f7f7ef', fontFamily: 'Helvetica, Arial, sans-serif', padding: '24px 0' } },
  container: { style: { backgroundColor: '#ffffff', borderRadius: '16px', margin: '0 auto', maxWidth: '560px', padding: '32px' } },
  heading: { style: { color: '#2a5c47', fontSize: '24px', fontWeight: 600, margin: '0 0 16px' } },
  text: { style: { color: '#26352f', fontSize: '16px', lineHeight: '24px' } },
  details: { style: { backgroundColor: '#f2f5f1', borderRadius: '12px', margin: '24px 0', padding: '18px 20px' } },
  detail: { style: { color: '#26352f', fontSize: '15px', lineHeight: '23px', margin: '4px 0' } },
  divider: { style: { borderColor: '#e2e7e3', margin: '24px 0' } },
  footer: { style: { color: '#59645f', fontSize: '13px', lineHeight: '20px' } },
}

export default function BookingConfirmedEmail({
  requesterName,
  service,
  date,
  time,
  room,
  address,
  copy,
}: {
  requesterName: string
  service: string
  date: string
  time: string
  room: string
  address: string
  copy: BookingConfirmedEmailCopy
}) {
  return (
    <Html>
      <Head><title>{copy.heading}</title></Head>
      <Preview>{copy.preview}</Preview>
      <Body {...styles.body}>
        <Container {...styles.container}>
          <Heading {...styles.heading}>{copy.heading}</Heading>
          <Text {...styles.text}>{copy.greeting} {requesterName},</Text>
          <Text {...styles.text}>{copy.body}</Text>
          <Section {...styles.details}>
            <Text {...styles.detail}><strong>{copy.serviceLabel}:</strong> {service}</Text>
            <Text {...styles.detail}><strong>{copy.dateLabel}:</strong> {date}</Text>
            <Text {...styles.detail}><strong>{copy.timeLabel}:</strong> {time}</Text>
            <Text {...styles.detail}><strong>{copy.roomLabel}:</strong> {room}</Text>
            <Text {...styles.detail}><strong>{copy.addressLabel}:</strong> {address}</Text>
          </Section>
          <Hr {...styles.divider} />
          <Text {...styles.footer}>{copy.footer}</Text>
        </Container>
      </Body>
    </Html>
  )
}
