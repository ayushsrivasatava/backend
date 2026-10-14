const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay'); 
const crypto = require('crypto'); 
// ADD THIS AT THE TOP (Below your other requires)
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 5000;

// Enable JSON body parsing and cross-origin access for Expo/Mobile
app.use(cors());
app.use(express.json());

// 1. MongoDB Connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://ayushsrivastava:ayush0541@cluster0.5eqo003.mongodb.net/?appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch((err) => console.error('MongoDB connection error:', err));
// Add this right above app.listen(port, ...)
app.get('/api/charging-sessions', async (req, res) => {
  try {
    const sessions = await ChargingSession.find({}); // Fetch all records
    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// 2. MongoDB Schema & Model for Storing Charging History / Bookings
const ChargingSessionSchema = new mongoose.Schema({
  terminalId: { type: Number, required: true },
  vehicleType: { type: Number, required: true },
  batteryCapacity: { type: Number, required: true },
  initialSoc: { type: Number, required: true },
  chargeNow: { type: Boolean, default: true },
  scheduledTime: { type: String, default: 'NOW' },
  amountInr: { type: Number },
  razorpayOrderId: { type: String }, // Stores Payment Link ID
  razorpayPaymentId: { type: String },
  paymentStatus: { type: String, default: 'PENDING' }, // PENDING, SUCCESS, FAILED
  createdAt: { type: Date, default: Date.now }
});

const ChargingSession = mongoose.model('ChargingSession', ChargingSessionSchema);

// Map terminal IDs to their ThingsBoard Device Tokens
const DEVICE_TOKENS = {
  1: process.env.TB_TOKEN_BAY1 || 'LER9rackcZb3NG7xCg2i',
  2: process.env.TB_TOKEN_BAY2 || 'LER9rackcZb3NG7xCg2i', 
  3: process.env.TB_TOKEN_BAY3 || 'LER9rackcZb3NG7xCg2i',
};

// --- Initialize Razorpay ---
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_TnUkNJrG2f4Y5W', 
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'HJN1qln1DseiwyjFJa04NSBI',
});
// ADD THIS BELOW YOUR RAZORPAY INITIALIZATION
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'ayushsrivastavaind@gmail.com',
    pass: 'xmmfdkzxghncmlkn'
  }
});
// 3. Health check route
app.get('/', (req, res) => {
  res.send({ status: 'EV Charging Backend Online', database: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected' });
});

// 4. Car Configuration & Booking Route (Existing route placeholder)
app.post('/api/set-car-config', async (req, res) => {
    // ... your existing code ...
});

// 5. Query Recent Charging Sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await ChargingSession.find().sort({ createdAt: -1 }).limit(10);
    res.status(200).json({ success: true, sessions });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- UPDATED: Dynamic Razorpay Payment Link Generation Route ---
app.post('/api/create-payment-link', async (req, res) => {
  try {
    const { amount, terminalId, vehicleType, batteryCapacity, initialSoc } = req.body; 

    // Generate a web-based Payment Link with dynamic pricing
    const paymentLink = await razorpay.paymentLink.create({
      amount: (amount || 145) * 100, // Convert to paise
      currency: "INR",
      accept_partial: false,
      description: `Optium-EV Session Payment (Terminal ${terminalId})`,
      customer: {
        name: "Ayush Srivastava",
        email: "2023041029@mmmut.ac.in",
        contact: "+919166947949"
      },
      notify: { sms: false, email: false },
      reminder_enable: false
    });
    
    // Save a "PENDING" session to MongoDB with dynamic parameters
    const newSession = new ChargingSession({
      terminalId: terminalId || 2,
      vehicleType: vehicleType || 2, 
      batteryCapacity: batteryCapacity || 50,
      initialSoc: initialSoc || 20,
      amountInr: amount || 145,
      razorpayOrderId: paymentLink.id,
      paymentStatus: 'PENDING'
    });
    await newSession.save();

    res.status(200).json({
      success: true,
      url: paymentLink.short_url,
      linkId: paymentLink.id,
      sessionId: newSession._id
    });
  } catch (error) {
    console.error("Payment Link Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Manual Link Payment Settlement Route ---
// Triggered when the user confirms completion inside the mobile app
// --- Manual Link Payment Settlement Route (WITH EMAIL RECEIPT) ---
app.post('/api/verify-link-payment', async (req, res) => {
  try {
    const { linkId } = req.body;

  // 1. Ask Razorpay for the REAL status of this payment link
    const linkDetails = await razorpay.paymentLink.fetch(linkId);

    // 2. If it is NOT paid, reject the request!
    if (linkDetails.status !== 'paid') {
      return res.status(400).json({ 
        success: false, 
        message: `Payment is currently ${linkDetails.status.toUpperCase()}. Please complete the payment successfully before verifying.` 
      });
    }

    // 3. If it IS paid, extract the real payment ID and update MongoDB
    const realPaymentId = linkDetails.payments && linkDetails.payments.length > 0 
      ? linkDetails.payments[0].payment_id 
      : `pay_verified_${Date.now()}`;

    const updatedSession = await ChargingSession.findOneAndUpdate(
      { razorpayOrderId: linkId },
      { paymentStatus: 'SUCCESS', razorpayPaymentId: realPaymentId },
      { new: true } 
    );

    if (updatedSession) {
      // Send Automated Receipt via Email
      const mailOptions = {
        from: 'ayushsrivastavaind@gmail.com',
        to: 'ayushsrivastavaind@gmail.com', 
        subject: `Payment Receipt: Optium-EV Terminal ${updatedSession.terminalId}`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; max-width: 500px;">
            <h2 style="color: #2b6cb0;">Optium-EV Charging Receipt</h2>
            <p>Thank you for charging with us. Your payment has been successfully settled.</p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
            <p><strong>Terminal ID:</strong> ${updatedSession.terminalId}</p>
            <p><strong>Amount Paid:</strong> ₹${updatedSession.amountInr}</p>
            <p><strong>Transaction ID:</strong> ${updatedSession.razorpayPaymentId}</p>
            <p><strong>Date:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
            <br>
            <p style="font-size: 12px; color: #718096;">If you have any questions, please contact support.</p>
          </div>
        `
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) console.error("Email Error:", error);
        else console.log("Email receipt sent:", info.response);
      });

      res.status(200).json({ success: true, message: 'Session marked as paid and receipt sent!' });
    } else {
      res.status(404).json({ success: false, message: 'Session not found for this link ID.' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// --- Vehicle Schema ---
const vehicleSchema = new mongoose.Schema({
  userEmail: { type: String, required: true },
  label: { type: String, required: true }, // e.g., "Tata Nexon EV"
  typeId: { type: Number, required: true }, // 1=Bike, 2=Car, 3=Bus
  batteryCapacity: { type: Number, required: true }, // in kWh
  createdAt: { type: Date, default: Date.now }
});

const Vehicle = mongoose.model('Vehicle', vehicleSchema);

// --- Fetch User Vehicles ---
app.get('/api/vehicles/:email', async (req, res) => {
  try {
    const vehicles = await Vehicle.find({ userEmail: req.params.email }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: vehicles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Add New Vehicle ---
app.post('/api/vehicles', async (req, res) => {
  try {
    const { userEmail, label, typeId, batteryCapacity } = req.body;
    const newVehicle = new Vehicle({ userEmail, label, typeId, batteryCapacity });
    await newVehicle.save();
    res.status(201).json({ success: true, data: newVehicle });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// --- Standard Razorpay Order Verification Route ---
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'HJN1qln1DseiwyjFJa04NSBI')
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      await ChargingSession.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        { paymentStatus: 'SUCCESS', razorpayPaymentId: razorpay_payment_id }
      );
      res.status(200).json({ success: true, message: 'Payment verified and saved to MongoDB!' });
    } else {
      await ChargingSession.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        { paymentStatus: 'FAILED' }
      );
      res.status(400).json({ success: false, message: 'Invalid signature, payment verification failed!' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});