-- AddColumn: motoboy panel auth fields
ALTER TABLE "Motoboy" ADD COLUMN IF NOT EXISTS "cedula" TEXT;
ALTER TABLE "Motoboy" ADD COLUMN IF NOT EXISTS "placa" TEXT;
ALTER TABLE "Motoboy" ADD COLUMN IF NOT EXISTS "senhaHash" TEXT;
