import { PayPalApi, Environment } from '@paypal/paypal-server-sdk'

const environment = process.env.PAYPAL_ENVIRONMENT === 'production'
  ? Environment.Production
  : Environment.Sandbox

const paypalClient = new PayPalApi({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: environment,
})

export default paypalClient