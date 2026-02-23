interface acccuntI {
    accountNumber: number;
    balance: number;
    owner: string
}

class account {
    #accountNumber: number;
    #balance: number;
    #owner: string;

    constructor(accountNumber:number, balance:number, owner:string){
        this.#accountNumber = accountNumber
        this.#balance = balance
        this.#owner = owner
    }
    
    deposit(number:number){
        const balance = this.#balance+=number
        console.log(`This is your balance ${balance}`)
    }

    checkBalance(){
        this.#balance
    }
    
}