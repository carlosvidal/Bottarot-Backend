import pkg from '@paypal/paypal-server-sdk'
const { Client, Environment } = pkg

const environment = process.env.PAYPAL_ENVIRONMENT === 'production'
  ? Environment.Production
  : Environment.Sandbox

const paypalClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: environment,
})

export default paypalClient